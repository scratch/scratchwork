/**
 * Dynamic Client Registration (RFC 7591) storage for the MCP OAuth surface.
 * Registrations are public clients (PKCE only, no client secret) kept in
 * PrimitiveDb with a 90-day expiry: expired registrations read as absent on
 * every backend, and MCP clients re-register automatically when their
 * client_id stops resolving. Redirect-URI policy lives here too, so the
 * registration check and the authorize-time match cannot drift apart.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";
import { PrimitiveDb, type PrimitiveDbConflict, type PrimitiveDbError } from "./db.ts";

/** Namespace of client registrations; the key is the client_id. */
const MCP_CLIENT_NAMESPACE = "oauth-clients";
/** Registrations expire after 90 days; clients re-register on invalid_client. */
const MCP_CLIENT_TTL_SECONDS = 90 * 24 * 60 * 60;
/** Live-registration ceiling: one full list page. Registration is rare (once
 * per client per 90 days), so a page read per registration is acceptable, and
 * the cap bounds storage against automated registration spam. */
const MAX_LIVE_CLIENTS = 1000;
/** RFC 7591 metadata limits. */
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 256;
/** client_ids are 16 random bytes as 22 base64url characters. */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** An RFC 7591 registration failure; `error` is the spec error code. */
export class McpClientRegistrationError extends Data.TaggedError("McpClientRegistrationError")<{
  readonly status: number;
  readonly error: "invalid_client_metadata" | "invalid_redirect_uri";
  readonly description: string;
}> {}

/** One stored client registration. */
const McpClientRecordSchema = Schema.Struct({
  clientName: Schema.optional(Schema.String),
  redirectUris: Schema.Array(Schema.String),
  createdAt: Schema.Number,
});
type McpClientRecord = typeof McpClientRecordSchema.Type;

/** A registered client joined with its id. */
export interface McpClient extends McpClientRecord {
  readonly clientId: string;
}

/** The RFC 7591 request fields the server acts on. Decoding is deliberately
 * tolerant of extra fields — registration requests legitimately carry
 * arbitrary client metadata the server ignores — while the fields it does
 * read are validated strictly below. */
const RegistrationRequestSchema = Schema.Struct({
  redirect_uris: Schema.optional(Schema.Array(Schema.String)),
  client_name: Schema.optional(Schema.String),
  token_endpoint_auth_method: Schema.optional(Schema.String),
  grant_types: Schema.optional(Schema.Array(Schema.String)),
  response_types: Schema.optional(Schema.Array(Schema.String)),
});

/** Grants the server supports; a registration asking for more is rejected. */
const SUPPORTED_GRANT_TYPES: ReadonlySet<string> = new Set(["authorization_code", "refresh_token"]);
const SUPPORTED_RESPONSE_TYPES: ReadonlySet<string> = new Set(["code"]);

/** The RFC 7591 registration response body. */
export interface McpClientRegistrationResponse {
  readonly client_id: string;
  readonly client_id_issued_at: number;
  readonly client_name?: string;
  readonly redirect_uris: ReadonlyArray<string>;
  readonly token_endpoint_auth_method: "none";
  readonly grant_types: ReadonlyArray<string>;
  readonly response_types: ReadonlyArray<string>;
}

/** Validates one registration request and stores the client. The parsed JSON
 * body is taken as unknown so this module owns the whole RFC 7591 contract. */
export function registerMcpClient(
  body: unknown,
): Effect.Effect<
  McpClientRegistrationResponse,
  McpClientRegistrationError | PrimitiveDbError | PrimitiveDbConflict,
  PrimitiveDb
> {
  return Effect.gen(function* () {
    const invalidMetadata = (description: string) =>
      new McpClientRegistrationError({ status: 400, error: "invalid_client_metadata", description });
    const request = yield* Schema.decodeUnknown(RegistrationRequestSchema)(body).pipe(
      Effect.mapError(() => invalidMetadata("Malformed client metadata")),
    );

    const redirectUris = request.redirect_uris ?? [];
    if (redirectUris.length === 0) {
      return yield* Effect.fail(
        new McpClientRegistrationError({
          status: 400,
          error: "invalid_redirect_uri",
          description: "redirect_uris is required and must not be empty",
        }),
      );
    }
    if (redirectUris.length > MAX_REDIRECT_URIS) {
      return yield* Effect.fail(
        new McpClientRegistrationError({
          status: 400,
          error: "invalid_redirect_uri",
          description: `At most ${MAX_REDIRECT_URIS} redirect_uris are accepted`,
        }),
      );
    }
    for (const uri of redirectUris) {
      if (!validMcpRedirectUri(uri)) {
        return yield* Effect.fail(
          new McpClientRegistrationError({
            status: 400,
            error: "invalid_redirect_uri",
            description: "redirect_uris must be https URLs, or http URLs on a loopback host, without credentials or fragments",
          }),
        );
      }
    }

    if (request.token_endpoint_auth_method != null && request.token_endpoint_auth_method !== "none") {
      return yield* Effect.fail(invalidMetadata('Only token_endpoint_auth_method "none" is supported (public client with PKCE)'));
    }
    if (request.grant_types?.some((grant) => !SUPPORTED_GRANT_TYPES.has(grant))) {
      return yield* Effect.fail(invalidMetadata('Only the "authorization_code" and "refresh_token" grant types are supported'));
    }
    if (request.response_types?.some((type) => !SUPPORTED_RESPONSE_TYPES.has(type))) {
      return yield* Effect.fail(invalidMetadata('Only the "code" response type is supported'));
    }
    const clientName = request.client_name?.trim() || undefined;
    if (clientName != null && clientName.length > MAX_CLIENT_NAME_LENGTH) {
      return yield* Effect.fail(invalidMetadata(`client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`));
    }

    const db = yield* PrimitiveDb;
    const page = yield* db.list(MCP_CLIENT_NAMESPACE, { limit: MAX_LIVE_CLIENTS });
    if (page.cursor != null) {
      return yield* Effect.fail(
        new McpClientRegistrationError({
          status: 429,
          error: "invalid_client_metadata",
          description: "Client registration limit reached — retry later",
        }),
      );
    }

    const clientId = randomClientId();
    const createdAt = Math.floor(Date.now() / 1000);
    const record: McpClientRecord = {
      ...(clientName == null ? {} : { clientName }),
      redirectUris,
      createdAt,
    };
    // ifNoneMatch guards against the astronomically unlikely id collision; a
    // conflict surfaces as a 500 the client simply retries.
    yield* db.put(MCP_CLIENT_NAMESPACE, clientId, record, {
      ifNoneMatch: "*",
      expiresAt: createdAt + MCP_CLIENT_TTL_SECONDS,
    });

    return {
      client_id: clientId,
      client_id_issued_at: createdAt,
      ...(clientName == null ? {} : { client_name: clientName }),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: [...SUPPORTED_GRANT_TYPES],
      response_types: [...SUPPORTED_RESPONSE_TYPES],
    };
  });
}

/** Loads one live client registration; null when the id is malformed, unknown,
 * or expired (PrimitiveDb reads expired records as absent on every backend). */
export function loadMcpClient(
  clientId: string,
): Effect.Effect<McpClient | null, PrimitiveDbError, PrimitiveDb> {
  return Effect.gen(function* () {
    if (!CLIENT_ID_PATTERN.test(clientId)) return null;
    const db = yield* PrimitiveDb;
    const record = yield* db.get(MCP_CLIENT_NAMESPACE, clientId);
    if (record == null) return null;
    // A stored value this module did not write (or a corrupted one) reads as
    // an unknown client, which makes the MCP client re-register.
    const decoded = yield* Schema.decodeUnknown(McpClientRecordSchema)(record.value).pipe(
      Effect.orElseSucceed(() => null),
    );
    return decoded == null ? null : { clientId, ...decoded };
  });
}

/** Accepts an OAuth redirect URI per RFC 8252: https on any host, or http on a
 * loopback host, never with credentials or a fragment. */
export function validMcpRedirectUri(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) return false;
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && isMcpLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** Matches a presented redirect_uri against the registered set: byte-exact,
 * except that http-loopback registrations match on host, path, and query with
 * any port (RFC 8252 §7.3 — the client binds an ephemeral port per flow). */
export function redirectUriMatches(registered: ReadonlyArray<string>, presented: string): boolean {
  if (!validMcpRedirectUri(presented)) return false;
  if (registered.includes(presented)) return true;
  let presentedUrl: URL;
  try {
    presentedUrl = new URL(presented);
  } catch {
    return false;
  }
  if (presentedUrl.protocol !== "http:" || !isMcpLoopbackHost(presentedUrl.hostname)) return false;
  return registered.some((candidate) => {
    try {
      const url = new URL(candidate);
      return (
        url.protocol === "http:" &&
        url.hostname === presentedUrl.hostname &&
        url.pathname === presentedUrl.pathname &&
        url.search === presentedUrl.search
      );
    } catch {
      return false;
    }
  });
}

/** RFC 8252 loopback hosts (same set the CLI login flow accepts). */
function isMcpLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** Generates a client_id: 16 random bytes as 22 base64url characters. */
function randomClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Encoding.encodeBase64Url(bytes);
}
