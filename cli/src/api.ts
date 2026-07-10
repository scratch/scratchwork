/*
 * HTTP client for the Scratchwork server's JSON API.
 *
 * Every command talks to the server through apiRequest/apiJson so that
 * transport failures, error-body decoding, and bearer-token auth are handled
 * in exactly one place. All failures become CliError, prefixed with the
 * calling command's context string (for example "scratchwork publish").
 */
import type { PlatformError } from "@effect/platform/Error";
import type * as FileSystem from "@effect/platform/FileSystem";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import type * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProjectResponseSchema } from "../../shared/src/publish/api";
import { isRecord, parseJson } from "../../shared/src/util/json";
import { readAuthToken, readCfToken, serverApiUrl } from "./auth";
import { CliError, errorMessage } from "./errors";

/** A completed API exchange: HTTP status plus the raw and JSON-decoded body. */
export interface ApiResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
  readonly json: unknown;
}

/** Options for one API request; `token` adds a bearer Authorization header. */
export interface ApiRequestOptions {
  readonly method?: "GET" | "POST" | "DELETE";
  readonly token?: string;
  readonly body?: unknown;
}

/** A project name fully resolved to the server that hosts it. */
export interface ResolvedProjectRef {
  readonly server: string;
  readonly project: string;
}

/**
 * Executes one JSON API request. Transport failures (unreachable server,
 * aborted response) fail with a context-prefixed CliError; HTTP error statuses
 * are returned in the ApiResponse for the caller to interpret — except a
 * Cloudflare Access edge block, which fails with a re-auth hint since no
 * caller can act on it. Requests are interruption-safe: Ctrl-C aborts the
 * in-flight request.
 */
export function apiRequest(
  context: string,
  url: URL | string,
  options: ApiRequestOptions = {},
): Effect.Effect<ApiResponse, CliError, HttpClient.HttpClient | FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.make(options.method ?? "GET")(url);
    if (options.token != null) request = HttpClientRequest.bearerToken(request, options.token);
    request = yield* attachCloudflareAccess(request, url);
    if (options.body !== undefined) request = HttpClientRequest.bodyUnsafeJson(request, options.body);
    const response = yield* client.execute(request);
    const text = yield* response.text;
    if (edgeBlocked(response.status, response.headers, text)) {
      return yield* apiFail(
        context,
        "Cloudflare Access blocked this request. Run `scratchwork login` again (your Access session may have expired), or set SCRATCHWORK_CF_ACCESS_CLIENT_ID and SCRATCHWORK_CF_ACCESS_CLIENT_SECRET for automation.",
      );
    }
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      text,
      json: parseJson(text),
    };
  }).pipe(
    Effect.catchTags({
      RequestError: (error) => apiFail(context, errorMessage(error.cause ?? error)),
      ResponseError: (error) => apiFail(context, errorMessage(error.cause ?? error)),
    }),
  );
}

/** Executes an API request and fails with the server-reported error on non-2xx statuses. */
export function apiJson(
  context: string,
  url: URL | string,
  options: ApiRequestOptions = {},
): Effect.Effect<unknown, CliError, HttpClient.HttpClient | FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const response = yield* apiRequest(context, url, options);
    if (!response.ok) return yield* apiFail(context, apiErrorText(response));
    return response.json;
  });
}

/**
 * Attaches Cloudflare Access credentials so requests pass an Access-protected
 * edge: the Access JWT the server relayed at login (stored per origin, sent as
 * `cf-access-token`), and the service-token headers from
 * SCRATCHWORK_CF_ACCESS_CLIENT_ID/SECRET for CI and headless automation.
 * Cloudflare validates either at the edge; the server still identifies the
 * user by the bearer token. Servers without Access ignore the extra headers.
 */
function attachCloudflareAccess(
  request: HttpClientRequest.HttpClientRequest,
  url: URL | string,
): Effect.Effect<HttpClientRequest.HttpClientRequest, CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    let result = request;
    const cfToken = yield* readCfToken(new URL(url).origin);
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
  });
}

/** Matches Cloudflare Access artifacts in an HTML body where JSON was expected. */
const ACCESS_PAGE_MARKERS = /cloudflareaccess|CF_Authorization/i;

/**
 * Detects a request Cloudflare's edge blocked before it reached the server: a
 * 403 the edge tags with `cf-mitigated`, or an Access login page — HTML with
 * Access markers — where the API would have answered with JSON (the shape a
 * 302 to the login page takes after redirect following).
 */
function edgeBlocked(
  status: number,
  headers: Readonly<Record<string, string | undefined>>,
  text: string,
): boolean {
  if (status === 403 && headers["cf-mitigated"] != null) return true;
  return /^\s*<(!doctype|html)/i.test(text) && ACCESS_PAGE_MARKERS.test(text);
}

/** Extracts the most useful error text from a failed response: the JSON `error` field
 * when the server sent one, otherwise a short summary. Non-JSON bodies (Cloudflare or
 * proxy HTML error pages, stack dumps) are never echoed wholesale into the terminal —
 * an HTML page is reduced to its title and anything long is truncated. */
export function apiErrorText(response: ApiResponse): string {
  if (isRecord(response.json) && typeof response.json.error === "string" && response.json.error !== "") {
    return response.json.error;
  }
  const text = response.text.trim();
  if (text === "") return `server returned ${response.status}`;
  if (/^<(!doctype|html|!--)/i.test(text)) {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
    return title != null && title !== ""
      ? `server returned ${response.status}: ${title}`
      : `server returned ${response.status} with an HTML error page`;
  }
  return text.length > 300 ? `server returned ${response.status}: ${text.slice(0, 300)}…` : text;
}

/** Builds the API URL for one project, preserving any server path prefix. */
export function projectApiUrl(ref: ResolvedProjectRef, suffix = ""): URL {
  return serverApiUrl(
    ref.server,
    `/api/projects/${encodeURIComponent(ref.project)}${suffix}`,
  );
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
    const url = serverApiUrl(server, "/api/resolve");
    url.searchParams.set("path", pathname === "" ? "/" : pathname);
    const body = yield* apiJson(`scratchwork ${command}`, url, { token });
    // Tolerant decoding on purpose: unknown fields from a newer server are ignored.
    const decoded = Schema.decodeUnknownOption(ProjectResponseSchema)(body);
    if (Option.isNone(decoded)) {
      return yield* Effect.fail(new CliError({ code: 1, message: `scratchwork ${command}: invalid server response` }));
    }
    return { project: decoded.value.project.project };
  });
}

/** Fails with a context-prefixed CliError. */
function apiFail(context: string, message: string): Effect.Effect<never, CliError> {
  return Effect.fail(new CliError({ code: 1, message: `${context}: ${message}` }));
}
