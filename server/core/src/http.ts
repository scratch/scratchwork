import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isLoopbackHost } from "@scratchwork/shared/util/url";
import type { ServerConfigShape } from "./config.ts";

/** Generic HTTP failure; `status` becomes the response status and `message` the error body. */
export class HttpError extends Data.TaggedError("HttpError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Builds a JSON response with common API security headers. */
export function jsonResponse(body: unknown, status: number): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.unsafeJson(body, {
    status,
    headers: securityHeaders(),
  });
}

/** Builds the standard `{ error }` JSON response. */
export function errorJson(status: number, message: string): HttpServerResponse.HttpServerResponse {
  return jsonResponse({ error: message }, status);
}

/** Returns security headers shared by API and published-site responses. */
export function securityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store, must-revalidate",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

/** Rejects API requests from cross-origin browser pages. Non-browser clients
 * send no Origin or Sec-Fetch-Site header and pass untouched. */
export function rejectCrossOriginApiRequest(
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

// ---------------------------------------------------------------------------
// Origins and URLs
// ---------------------------------------------------------------------------

/** Resolves the app-host origin (auth routes, API) for redirects and cookie scoping. */
export function appBaseUrl(request: HttpServerRequest.HttpServerRequest, config: { readonly appUrl?: string }): string {
  return publicBaseUrl(request, config.appUrl);
}

/** Resolves the content-host origin (published sites) for redirects and publish URLs. */
export function contentBaseUrl(request: HttpServerRequest.HttpServerRequest, config: { readonly contentUrl?: string }): string {
  return publicBaseUrl(request, config.contentUrl);
}

/** Resolves a public origin: the configured value, else the request's own origin. */
function publicBaseUrl(
  request: HttpServerRequest.HttpServerRequest,
  configuredPublicUrl: string | undefined,
): string {
  if (configuredPublicUrl != null) return configuredPublicUrl;
  const requestUrl = new URL(request.url, "http://scratchwork.local");
  const requestBase = requestBaseUrl(request, requestUrl);
  if (requestBase != null) return requestBase;
  return requestUrl.origin;
}

/** Reconstructs the request origin from x-forwarded-host/-proto or the Host header;
 * null when the request carries no usable host information. */
export function requestBaseUrl(
  request: HttpServerRequest.HttpServerRequest,
  requestUrl = new URL(request.url, "http://scratchwork.local"),
): string | null {
  const forwardedHost = request.headers["x-forwarded-host"];
  const host = forwardedHost ?? request.headers.host;
  if (host != null && host !== "") {
    const forwardedProto = request.headers["x-forwarded-proto"];
    const proto = forwardedProto ?? defaultProtoForHost(requestUrl, host);
    return `${proto}://${host}`;
  }
  return requestUrl.hostname === "scratchwork.local" ? null : requestUrl.origin;
}

/** Guesses http/https for a Host header when no forwarded proto is present:
 * loopback hosts get http, everything else https. */
function defaultProtoForHost(requestUrl: URL, host: string): "http" | "https" {
  if (requestUrl.hostname !== "scratchwork.local") return requestUrl.protocol === "http:" ? "http" : "https";
  return isLoopbackHost(host.replace(/:\d+$/, "")) ? "http" : "https";
}

/** Returns true when two URL strings share an origin; false for unparsable input. */
export function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/** Builds the user-facing URL returned by publish. The homepage project reports its
 * canonical home origin; every other project reports its content route. */
export function publishedUrl(baseUrl: string, project: string, openPath: string, config: ServerConfigShape): string {
  const homepageBase = homepageBaseUrl(project, config);
  if (homepageBase != null) return `${homepageBase}${encodeOpenPath(openPath)}`;
  return `${baseUrl}/${encodeURIComponent(project)}${encodeOpenPath(openPath)}`;
}

/** The user-facing root URL of one project (see publishedUrl). */
export function projectUrl(project: string, contentBase: string, config: ServerConfigShape): string {
  const homepageBase = homepageBaseUrl(project, config);
  if (homepageBase != null) return `${homepageBase}/`;
  return `${contentBase}/${encodeURIComponent(project)}/`;
}

/** The canonical home origin when the project is the configured homepage, else null. */
export function homepageBaseUrl(project: string, config: ServerConfigShape): string | null {
  return config.homepageProject != null && project === config.homepageProject
    ? config.homepageUrls[0] ?? null
    : null;
}

/** URL-encodes each path segment without encoding slashes. */
function encodeOpenPath(openPath: string): string {
  return openPath.split("/").map((segment, index) => index === 0 ? "" : encodeURIComponent(segment)).join("/");
}
