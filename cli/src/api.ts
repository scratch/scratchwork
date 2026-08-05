/*
 * HTTP client for the Scratchwork server's JSON API, derived from the shared
 * HttpApi contract (invariant 2): apiClient returns the typed client that
 * HttpApiClient derives from ScratchworkApi, so URLs, request encoding, and
 * response decoding all come from the one contract object and cannot drift
 * from the server. Responses are decoded with the schema defaults (tolerant:
 * unknown fields from a newer server are ignored).
 *
 * One transformed HttpClient underneath the derived client owns every
 * transport concern in exactly one place: bearer-token and Cloudflare Access
 * credentials on the way out; transport failures, Cloudflare edge blocks, and
 * the shared {error}-envelope on the way back, each normalized into an
 * ApiError that commands turn into CliError via mapApiErrors (prefixed with
 * the calling command's context string, for example "scratchwork publish").
 * Requests that fail at the transport layer before a response arrives are
 * retried on a fresh connection (see isTransportFailure) before being
 * surfaced. Requests are interruption-safe: Ctrl-C aborts the in-flight
 * request.
 */
import type { PlatformError } from "@effect/platform/Error";
import type * as FileSystem from "@effect/platform/FileSystem";
import * as HttpApiClient from "@effect/platform/HttpApiClient";
import type * as HttpApiError from "@effect/platform/HttpApiError";
import * as HttpClient from "@effect/platform/HttpClient";
import type * as HttpClientError from "@effect/platform/HttpClientError";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import type * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import type * as Path from "@effect/platform/Path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import type * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import { ApiErrorBodySchema, CLI_TOKEN_EXCHANGE_PATH, ScratchworkApi } from "@scratchwork/shared/publish/api";
import { readAuthToken, readCfToken } from "./auth";
import { CliError, errorMessage } from "./errors";

/**
 * A normalized JSON API failure. `status` is the HTTP status of the server's
 * response, or null when no API response was received at all — transport
 * failures (unreachable server, aborted response) and requests Cloudflare's
 * edge blocked before they reached the server. `message` is the most useful
 * error text: the shared {error}-envelope's message when the server sent one,
 * a re-auth hint for Cloudflare Access blocks, and a short summary otherwise
 * (an HTML page is reduced to its title and anything long is truncated, so
 * proxy error pages and stack dumps are never echoed wholesale into the
 * terminal).
 */
export class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: number | null;
  readonly message: string;
}> {}

/** A project name fully resolved to the server that hosts it. */
export interface ResolvedProjectRef {
  readonly server: string;
  readonly project: string;
}

/** Every failure a derived-client call can produce: the normalized ApiError,
 * a decode failure for a 2xx body outside the contract (ParseError,
 * ResponseError, or the contract's implicit HttpApiDecodeError — the latter
 * two only in the type, since normalizeFailures consumes every non-2xx before
 * the decode map sees it), or a client error that escaped normalization. */
type ApiClientError =
  | ApiError
  | HttpApiError.HttpApiDecodeError
  | HttpClientError.HttpClientError
  | ParseResult.ParseError;

/**
 * Builds the contract-derived API client for one server. `token` adds a
 * bearer Authorization header to every request; Cloudflare Access credentials
 * (the Access JWT relayed at login, and the service-token env vars for CI)
 * are attached automatically. Servers without Access ignore the extra
 * headers.
 */
export function apiClient(
  server: string,
  options: { readonly token?: string } = {},
): Effect.Effect<
  ScratchworkApiClient,
  CliError,
  HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const cfToken = yield* readCfToken(new URL(server).origin);
    const client = http.pipe(
      HttpClient.mapRequest(attachCredentials(options.token, cfToken)),
      HttpClient.retry({ while: isTransportFailure, times: 2 }),
      HttpClient.transform(normalizeFailures),
    );
    return yield* HttpApiClient.makeWith(ScratchworkApi, { httpClient: client, baseUrl: server });
  });
}

/** The typed client HttpApiClient derives from the shared contract. */
export type ScratchworkApiClient = Effect.Effect.Success<ReturnType<typeof makeRawClient>>;

/** Type helper: the un-narrowed HttpApiClient constructor for the contract. */
function makeRawClient(httpClient: HttpClient.HttpClient.With<ApiClientError>) {
  return HttpApiClient.makeWith(ScratchworkApi, { httpClient });
}

/**
 * Maps every API-client failure to a context-prefixed CliError: an ApiError
 * carries its normalized message; a ParseError or ResponseError from decoding
 * a 2xx body means the server answered outside the contract. Errors of other
 * types (for example a command's own) pass through untouched.
 */
export function mapApiErrors(context: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, CliError | Exclude<E, ApiClientError>, R> =>
    Effect.catchIf(effect, isApiClientError, (error) => apiFail(context, apiClientErrorMessage(error))) as Effect.Effect<
      A,
      CliError | Exclude<E, ApiClientError>,
      R
    >;
}

/** Narrows an unknown failure to the client error union by tag. */
function isApiClientError(error: unknown): error is ApiClientError {
  return typeof error === "object" && error != null && "_tag" in error
    && (error._tag === "ApiError" || error._tag === "ParseError"
      || error._tag === "RequestError" || error._tag === "ResponseError"
      || error._tag === "HttpApiDecodeError");
}

/** The CliError message for one client failure (see mapApiErrors). */
function apiClientErrorMessage(error: ApiClientError): string {
  switch (error._tag) {
    case "ApiError":
      return error.message;
    case "RequestError":
      return errorMessage(error.cause ?? error);
    default:
      return "invalid server response";
  }
}

/**
 * Asks the server which project a published content path belongs to. The
 * endpoint centralizes validation and authorization, and stays host-aware for
 * URL shapes a local parse cannot resolve.
 */
export function resolveProjectByPath(
  server: string,
  pathname: string,
  command: string,
): Effect.Effect<
  { readonly project: string },
  PlatformError | CliError,
  HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const token = yield* readAuthToken(server);
    const client = yield* apiClient(server, { token });
    const response = yield* client.resolve({ urlParams: { path: pathname === "" ? "/" : pathname } }).pipe(
      mapApiErrors(`scratchwork ${command}`),
    );
    return { project: response.project.project };
  });
}

/**
 * True for a request that failed at the transport layer, before any API
 * response arrived. The common shape is a stale keep-alive socket: proxies
 * close idle pooled connections (Cloudflare's edge after ~400s), and a
 * long-lived command — `scratchwork stream` republishing after an idle gap —
 * then fails its next request with a connection-closed error instead of
 * reaching the server. Every API endpoint tolerates a replay (publish
 * re-uploads the same bundle; share/revoke/unpublish/delete are idempotent),
 * so these are retried on a fresh connection rather than surfaced.
 */
function isTransportFailure(error: HttpClientError.HttpClientError): boolean {
  return error._tag === "RequestError" && error.reason === "Transport";
}

// ---------------------------------------------------------------------------
// Outgoing credentials
// ---------------------------------------------------------------------------

/**
 * Attaches the bearer token and Cloudflare Access credentials to one outgoing
 * request: the Access JWT the server relayed at login (stored per origin,
 * sent as `cf-access-token`), and the service-token headers from
 * SCRATCHWORK_CF_ACCESS_CLIENT_ID/SECRET for CI and headless automation.
 * Cloudflare validates either at the edge; the server still identifies the
 * user by the bearer token.
 */
function attachCredentials(token: string | undefined, cfToken: string | undefined) {
  return (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest => {
    let result = request;
    if (token != null) result = HttpClientRequest.bearerToken(result, token);
    if (cfToken != null) result = HttpClientRequest.setHeader(result, "cf-access-token", cfToken);
    const clientId = process.env.SCRATCHWORK_CF_ACCESS_CLIENT_ID;
    const clientSecret = process.env.SCRATCHWORK_CF_ACCESS_CLIENT_SECRET;
    if (clientId != null && clientId !== "" && clientSecret != null && clientSecret !== "") {
      result = HttpClientRequest.setHeaders(result, {
        "CF-Access-Client-Id": clientId,
        "CF-Access-Client-Secret": clientSecret,
      });
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// Incoming failure normalization
// ---------------------------------------------------------------------------

/** Normalizes one exchange: transport failures become ApiError immediately;
 * responses are classified before the contract decode ever sees them. */
function normalizeFailures<R>(
  effect: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError, R>,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpClientResponse.HttpClientResponse, ApiError, R> {
  return effect.pipe(
    Effect.catchAll((error) =>
      Effect.fail(new ApiError({ status: null, message: errorMessage(error.cause ?? error) })),
    ),
    Effect.flatMap((response) => classifyResponse(request, response)),
  );
}

/**
 * Classifies one received response. A 2xx JSON response passes through with
 * its body untouched for the contract decode. Everything else is consumed
 * here and becomes an ApiError: a Cloudflare edge block (a 403 the edge tags
 * with `cf-mitigated`, or an Access login page — HTML with Access markers —
 * where the API would have answered JSON, the shape a 302 to the login page
 * takes after redirect following) gets a re-auth hint; any other non-2xx (or
 * an HTML body where the API answers only JSON) gets its extracted error
 * text.
 */
function classifyResponse(
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<HttpClientResponse.HttpClientResponse, ApiError> {
  const ok = response.status >= 200 && response.status < 300;
  const html = /text\/html/i.test(response.headers["content-type"] ?? "");
  if (ok && !html) return Effect.succeed(response);
  return Effect.gen(function* () {
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    if (edgeBlocked(response.status, response.headers, text)) {
      return yield* Effect.fail(new ApiError({ status: null, message: cloudflareAccessBlockedMessage(request.url) }));
    }
    return yield* Effect.fail(new ApiError({ status: response.status, message: apiErrorText(response.status, text) }));
  });
}

/** Explains the circular first-login failure separately from an expired Access
 * session on an ordinary API request. The exchange cannot use a stored Access
 * JWT because successfully calling it is how the CLI obtains that JWT. */
function cloudflareAccessBlockedMessage(url: string): string {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith(CLI_TOKEN_EXCHANGE_PATH)) {
    return "Cloudflare Access blocked the CLI token exchange. The server administrator must configure a Bypass / Everyone policy limited to `/auth/cli/token`, then run `scratchwork login` again. The Worker still validates the signed one-time code and PKCE verifier.";
  }
  return "Cloudflare Access blocked this request. Run `scratchwork login` again (your Access session may have expired), or set SCRATCHWORK_CF_ACCESS_CLIENT_ID and SCRATCHWORK_CF_ACCESS_CLIENT_SECRET for automation.";
}

/** Matches Cloudflare Access artifacts in an HTML body where JSON was expected. */
const ACCESS_PAGE_MARKERS = /cloudflareaccess|CF_Authorization/i;

/** Detects a request Cloudflare's edge blocked before it reached the server. */
function edgeBlocked(
  status: number,
  headers: Readonly<Record<string, string | undefined>>,
  text: string,
): boolean {
  if (status === 403 && headers["cf-mitigated"] != null) return true;
  return /^\s*<(!doctype|html)/i.test(text) && ACCESS_PAGE_MARKERS.test(text);
}

/** Matches the shared `{"error": "..."}` envelope, tolerating extra fields. */
const decodeErrorBody = Schema.decodeUnknownOption(ApiErrorBodySchema);

/** Extracts the most useful error text from a failed response body (see ApiError). */
function apiErrorText(status: number, text: string): string {
  const json = Either.getOrNull(Schema.decodeUnknownEither(Schema.parseJson())(text));
  const errorBody = Option.getOrNull(decodeErrorBody(json));
  if (errorBody != null && errorBody.error !== "") {
    return errorBody.error;
  }
  const trimmed = text.trim();
  if (trimmed === "") return `server returned ${status}`;
  if (/^<(!doctype|html|!--)/i.test(trimmed)) {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(trimmed)?.[1]?.trim();
    return title != null && title !== ""
      ? `server returned ${status}: ${title}`
      : `server returned ${status} with an HTML error page`;
  }
  return trimmed.length > 300 ? `server returned ${status}: ${trimmed.slice(0, 300)}…` : trimmed;
}

/** Fails with a context-prefixed CliError. */
function apiFail(context: string, message: string): Effect.Effect<never, CliError> {
  return Effect.fail(new CliError({ code: 1, message: `${context}: ${message}` }));
}
