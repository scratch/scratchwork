import type * as HttpApp from "@effect/platform/HttpApp";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import { SiteFileError, SiteFiles } from "../../../shared/src/site/files";
import { servePath } from "../../../shared/src/site/serve";
import { defaultRendererHtml } from "../../../shared/src/site/default-renderer.generated.js";
import FIGURE_SVG from "../../../shared/assets/figure.svg" with { type: "text" };
import { Auth, AuthError } from "./auth";
import { ServerConfig } from "./config";
import { errorJson, HttpError, jsonResponse, securityHeaders } from "./http-error";
import { readPublishRequest } from "./publish-request";
import { SiteStore, SiteStoreError } from "./site-store";
import { StorageError } from "./storage";
import { safeSlug } from "./tokens";

const NO_STORE = "no-store, must-revalidate";

export const app: HttpApp.Default<never, ServerConfig | SiteStore | Auth> =
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* handleRequest(request).pipe(
      Effect.catchTags({
        HttpError: (error) => errorJson(error.status, error.message),
        AuthError: (error) => errorJson(error.status, error.message),
        SiteStoreError: (error) => errorJson(error.status, error.message),
        StorageError: (error) => errorJson(500, error.message),
      }),
    );
  });

/** Routes one HTTP request to auth, API, health, or published-site handling. */
function handleRequest(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
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
      return yield* auth.callback(request, url, publicBaseUrl(request, config.publicUrl));
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

/** Handles `POST /api/publish` through bearer auth and SiteStore. */
function publish(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, publicBaseUrl(request, config.publicUrl));
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const publishRequest = yield* readPublishRequest(request);
    const siteStore = yield* SiteStore;
    const result = yield* siteStore.publish(publishRequest, user);
    const url = publishedUrl(publicBaseUrl(request, config.publicUrl), result.slug, result.openPath);
    return yield* jsonResponse({ slug: result.slug, token: result.token, url }, 200);
  });
}

/** Loads and serves one published site route by slug. */
function servePublishedSite(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
  return Effect.gen(function* () {
    const match = /^\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match == null) {
      return HttpServerResponse.text("scratchwork server\n", {
        contentType: "text/plain; charset=utf-8",
        headers: securityHeaders(),
      });
    }

    const slug = match[1];
    if (!safeSlug(slug)) {
      return yield* Effect.fail(new HttpError({ status: 404, message: "Not found" }));
    }

    const siteStore = yield* SiteStore;
    const site = yield* siteStore.load(slug);
    if (site == null) {
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
      headers: publishedSiteHeaders,
      pathPrefix: `/${slug}`,
      rendererFallback: Effect.succeed(defaultRendererHtml),
    }).pipe(
      Effect.mapError((error) =>
        error instanceof SiteFileError
          ? new HttpError({ status: 500, message: error.message })
          : error,
      ),
      Effect.provideService(SiteFiles, site.siteFiles),
    );
  });
}

/** Rejects API mutations from cross-origin browser requests. */
function rejectCrossOriginApiRequest(
  request: HttpServerRequest.HttpServerRequest,
  baseUrl: string,
): Effect.Effect<void, HttpError> {
  const origin = request.headers.origin;
  if (origin != null && origin !== baseUrl) {
    return Effect.fail(new HttpError({ status: 403, message: "Cross-origin API request rejected" }));
  }
  const fetchSite = request.headers["sec-fetch-site"]?.toLowerCase();
  if (fetchSite === "cross-site") {
    return Effect.fail(new HttpError({ status: 403, message: "Cross-site API request rejected" }));
  }
  return Effect.void;
}

/** Adds isolation and static-asset headers for published content. */
function publishedSiteHeaders(path: string, responseContentType: string): Record<string, string> {
  const headers = securityHeaders();
  headers["Access-Control-Allow-Origin"] = "*";
  if (responseContentType.startsWith("text/html") || responseContentType === "image/svg+xml") {
    headers["Content-Security-Policy"] = "sandbox allow-scripts allow-forms allow-downloads; base-uri 'none'";
  }
  if (path.endsWith(".md")) {
    headers["X-Content-Type-Options"] = "nosniff";
  }
  return headers;
}

/** Resolves the public origin used in redirects and publish responses. */
function publicBaseUrl(
  request: HttpServerRequest.HttpServerRequest,
  configuredPublicUrl: string | undefined,
): string {
  if (configuredPublicUrl != null) return configuredPublicUrl;
  const requestUrl = new URL(request.url, "http://scratchwork.local");
  return requestUrl.origin;
}

/** Builds the user-facing URL returned by publish. */
function publishedUrl(baseUrl: string, slug: string, openPath: string): string {
  return `${baseUrl}/${slug}${encodeOpenPath(openPath)}`;
}

/** URL-encodes each path segment without encoding slashes. */
function encodeOpenPath(openPath: string): string {
  return openPath.split("/").map((segment, index) => index === 0 ? "" : encodeURIComponent(segment)).join("/");
}
