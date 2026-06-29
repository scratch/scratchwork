import type * as HttpApp from "@effect/platform/HttpApp";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { decodePublishBundle, type PublishBundle } from "../../../shared/src/publish/bundle";
import { SiteFileError } from "../../../shared/src/site/files";
import { servePath } from "../../../shared/src/site/serve";
import { defaultRendererHtml } from "../../../shared/src/site/default-renderer.generated.js";
import FIGURE_SVG from "../../../shared/assets/figure.svg" with { type: "text" };
import { Auth, AuthError } from "./auth";
import { bundleSiteFilesLayer } from "./bundle-site-files";
import { ServerConfig } from "./config";
import { ObjectStorage, StorageError } from "./storage";

const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SLUG_LENGTH = 10;
const TOKEN_BYTES = 32;
const NO_STORE = "no-store, must-revalidate";

interface PublishRequest {
  readonly bundle: PublishBundle;
  readonly openPath: string;
  readonly slug?: string;
  readonly token?: string;
}

interface PublishedSiteRecord {
  readonly version: 1;
  readonly slug: string;
  readonly tokenHash: string;
  readonly ownerId?: string;
  readonly ownerEmail?: string;
  readonly bundle: PublishBundle;
  readonly openPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

class HttpError extends Data.TaggedError("HttpError")<{
  readonly status: number;
  readonly message: string;
}> {}

export const app: HttpApp.Default<never, ServerConfig | ObjectStorage | Auth> =
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* handleRequest(request).pipe(
      Effect.catchAll((error) =>
        error instanceof HttpError
          ? jsonResponse({ error: error.message }, error.status)
          : error instanceof AuthError
            ? jsonResponse({ error: error.message }, error.status)
          : jsonResponse({ error: errorMessage(error) }, 500),
      ),
    );
  });

function handleRequest(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | StorageError, ServerConfig | ObjectStorage | Auth> {
  return Effect.gen(function* () {
    const url = new URL(request.url, "http://scratchwork.local");

    if (url.pathname === "/auth/login") {
      const auth = yield* Auth;
      const config = yield* ServerConfig;
      return yield* auth.login(request, url, publicBaseUrl(request, config.publicUrl));
    }

    if (url.pathname === "/auth/callback/google" || url.pathname === "/auth/google/callback") {
      const auth = yield* Auth;
      const config = yield* ServerConfig;
      return yield* auth.callback(url, publicBaseUrl(request, config.publicUrl));
    }

    if (url.pathname === "/auth/logout") {
      const auth = yield* Auth;
      const config = yield* ServerConfig;
      return auth.logout(publicBaseUrl(request, config.publicUrl));
    }

    if (url.pathname === "/health") {
      return yield* jsonResponse({ ok: true }, 200);
    }

    if (url.pathname === "/api/me") {
      const auth = yield* Auth;
      const user = yield* auth.currentUser(request);
      return yield* jsonResponse({ authenticated: user != null, user }, 200);
    }

    if (url.pathname === "/api/publish") {
      if (request.method !== "POST") {
        return yield* Effect.fail(new HttpError({ status: 405, message: "Method not allowed" }));
      }
      return yield* publish(request);
    }

    if (url.pathname.startsWith("/api/")) {
      return yield* Effect.fail(new HttpError({ status: 404, message: "Not found" }));
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return yield* Effect.fail(new HttpError({ status: 405, message: "Method not allowed" }));
    }

    return yield* servePublishedSite(request, url);
  });
}

function publish(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | StorageError, ServerConfig | ObjectStorage | Auth> {
  return Effect.gen(function* () {
    const auth = yield* Auth;
    const user = yield* auth.requireUser(request);
    const body = yield* request.json.pipe(
      Effect.mapError(() => new HttpError({ status: 400, message: "Invalid JSON body" })),
    );
    const publishRequest = yield* decodePublishRequest(body);
    const now = new Date().toISOString();

    const slug = publishRequest.slug ?? (yield* randomAvailableSlug());
    const token = publishRequest.token ?? randomToken();
    const requestTokenHash = publishRequest.token == null ? undefined : yield* tokenHash(publishRequest.token);
    const existing = yield* loadSite(slug);

    if (publishRequest.slug != null) {
      if (requestTokenHash == null) {
        return yield* Effect.fail(
          new HttpError({ status: 400, message: "A token is required to republish a slug" }),
        );
      }
      if (existing == null) {
        return yield* Effect.fail(new HttpError({ status: 404, message: "Slug not found" }));
      }
      if (existing.tokenHash !== requestTokenHash) {
        return yield* Effect.fail(new HttpError({ status: 403, message: "Invalid publish token" }));
      }
    }

    const record: PublishedSiteRecord = {
      version: 1,
      slug,
      tokenHash: requestTokenHash ?? (yield* tokenHash(token)),
      ownerId: user?.id,
      ownerEmail: user?.email,
      bundle: publishRequest.bundle,
      openPath: publishRequest.openPath,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    yield* saveSite(record);

    const config = yield* ServerConfig;
    const url = publishedUrl(publicBaseUrl(request, config.publicUrl), slug, publishRequest.openPath);
    return yield* jsonResponse({ slug, token, url }, 200);
  });
}

function servePublishedSite(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | StorageError, ServerConfig | ObjectStorage | Auth> {
  return Effect.gen(function* () {
    const match = /^\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match == null) {
      return HttpServerResponse.text("scratchwork server\n", {
        contentType: "text/plain; charset=utf-8",
      });
    }

    const slug = match[1];
    if (!safeSlug(slug)) {
      return yield* Effect.fail(new HttpError({ status: 404, message: "Not found" }));
    }

    const record = yield* loadSite(slug);
    if (record == null) {
      return yield* Effect.fail(new HttpError({ status: 404, message: "Not found" }));
    }

    const auth = yield* Auth;
    if (auth.enabled && (yield* auth.currentUser(request)) == null) {
      const config = yield* ServerConfig;
      return auth.loginRedirect(url, publicBaseUrl(request, config.publicUrl));
    }

    const rest = match[2];
    if (rest == null) {
      return HttpServerResponse.redirect(`/${slug}/`, { status: 308 });
    }

    return yield* servePath(rest, url.search, {
      cacheControl: () => NO_STORE,
      defaultFaviconSvg: FIGURE_SVG,
      pathPrefix: `/${slug}`,
      rendererFallback: Effect.succeed(defaultRendererHtml),
    }).pipe(
      Effect.mapError((error) =>
        error instanceof SiteFileError
          ? new HttpError({ status: 500, message: error.message })
          : error,
      ),
      Effect.provide(bundleSiteFilesLayer(record.bundle)),
    );
  });
}

function decodePublishRequest(value: unknown): Effect.Effect<PublishRequest, HttpError> {
  return Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Publish body must be an object" }));
    }

    const bundle = decodePublishBundle(value.bundle);
    if (bundle == null || bundle.files.length === 0) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Invalid publish bundle" }));
    }

    const openPath = typeof value.openPath === "string" ? normalizeOpenPath(value.openPath) : "/";
    if (openPath == null) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Invalid openPath" }));
    }

    const slug = optionalString(value.slug);
    const token = optionalString(value.token);
    if (slug != null && !safeSlug(slug)) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Invalid slug" }));
    }
    if (token != null && !safeToken(token)) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Invalid token" }));
    }
    if ((slug == null) !== (token == null)) {
      return yield* Effect.fail(
        new HttpError({ status: 400, message: "slug and token must be provided together" }),
      );
    }

    return { bundle, openPath, slug, token };
  });
}

function randomAvailableSlug(): Effect.Effect<string, HttpError | StorageError, ObjectStorage> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt++) {
      const slug = randomSlug();
      if ((yield* loadSite(slug)) == null) return slug;
    }
    return yield* Effect.fail(new HttpError({ status: 500, message: "Could not allocate slug" }));
  });
}

function loadSite(slug: string): Effect.Effect<PublishedSiteRecord | null, StorageError, ObjectStorage> {
  return Effect.gen(function* () {
    const storage = yield* ObjectStorage;
    const text = yield* storage.getText(siteKey(slug));
    if (text == null) return null;
    const parsed = parseJson(text);
    if (!isPublishedSiteRecord(parsed)) {
      return yield* Effect.fail(new StorageError({ message: `Invalid site record: ${slug}` }));
    }
    return parsed;
  });
}

function saveSite(record: PublishedSiteRecord): Effect.Effect<void, StorageError, ObjectStorage> {
  return Effect.gen(function* () {
    const storage = yield* ObjectStorage;
    yield* storage.putText(siteKey(record.slug), JSON.stringify(record));
  });
}

function isPublishedSiteRecord(value: unknown): value is PublishedSiteRecord {
  if (!isRecord(value) || value.version !== 1) return false;
  if (typeof value.slug !== "string" || !safeSlug(value.slug)) return false;
  if (typeof value.tokenHash !== "string") return false;
  if (value.ownerId != null && typeof value.ownerId !== "string") return false;
  if (value.ownerEmail != null && typeof value.ownerEmail !== "string") return false;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (typeof value.openPath !== "string") return false;
  return decodePublishBundle(value.bundle) != null;
}

function jsonResponse(
  body: unknown,
  status: number,
): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return Effect.succeed(HttpServerResponse.unsafeJson(body, { status }));
}

function publicBaseUrl(
  request: HttpServerRequest.HttpServerRequest,
  configuredPublicUrl: string | undefined,
): string {
  if (configuredPublicUrl != null) return configuredPublicUrl;
  const requestUrl = new URL(request.url, "http://scratchwork.local");
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = forwardedProto?.split(",")[0]?.trim() || requestUrl.protocol.replace(/:$/, "") || "http";
  const forwardedHost = request.headers["x-forwarded-host"];
  const host = forwardedHost?.split(",")[0]?.trim() || request.headers.host || requestUrl.host || "localhost:3001";
  return `${proto}://${host}`;
}

function publishedUrl(baseUrl: string, slug: string, openPath: string): string {
  return `${baseUrl}/${slug}${openPath}`;
}

function normalizeOpenPath(value: string): string | null {
  if (!value.startsWith("/") || value.includes("\0")) return null;
  const normalized = value.replace(/\/+/g, "/");
  return normalized === "" ? "/" : normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function siteKey(slug: string): string {
  return `sites/${slug}.json`;
}

function randomSlug(): string {
  const bytes = randomBytes(SLUG_LENGTH);
  let slug = "";
  for (const byte of bytes) {
    slug += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
  }
  return slug;
}

function randomToken(): string {
  return base64Url(randomBytes(TOKEN_BYTES));
}

function tokenHash(token: string): Effect.Effect<string, StorageError> {
  return Effect.tryPromise({
    try: async () => {
      const bytes = new TextEncoder().encode(token);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return hex(new Uint8Array(digest));
    },
    catch: (cause) => new StorageError({ message: "Could not hash publish token", cause }),
  });
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    output += alphabet[(triplet >> 18) & 63];
    output += alphabet[(triplet >> 12) & 63];
    if (index + 1 < bytes.length) output += alphabet[(triplet >> 6) & 63];
    if (index + 2 < bytes.length) output += alphabet[triplet & 63];
  }
  return output;
}

function hex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}

function safeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,63}$/.test(slug);
}

function safeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,256}$/.test(token);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { readonly message?: unknown })?.message;
  return typeof message === "string" ? message : String(error);
}
