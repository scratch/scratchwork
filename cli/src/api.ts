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
import { isRecord, parseJson } from "../../shared/src/util/json";
import { readAuthToken, serverApiUrl } from "./auth";
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
 * are returned in the ApiResponse for the caller to interpret. Requests are
 * interruption-safe: Ctrl-C aborts the in-flight request.
 */
export function apiRequest(
  context: string,
  url: URL | string,
  options: ApiRequestOptions = {},
): Effect.Effect<ApiResponse, CliError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.make(options.method ?? "GET")(url);
    if (options.token != null) request = HttpClientRequest.bearerToken(request, options.token);
    if (options.body !== undefined) request = HttpClientRequest.bodyUnsafeJson(request, options.body);
    const response = yield* client.execute(request);
    const text = yield* response.text;
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
): Effect.Effect<unknown, CliError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const response = yield* apiRequest(context, url, options);
    if (!response.ok) return yield* apiFail(context, apiErrorText(response));
    return response.json;
  });
}

/** Extracts the most useful error text from a failed response: its `error` field, raw body, or status. */
export function apiErrorText(response: ApiResponse): string {
  const fromBody = isRecord(response.json) && typeof response.json.error === "string" ? response.json.error : response.text;
  return fromBody || `server returned ${response.status}`;
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
    const project = isRecord(body) && isRecord(body.project) ? body.project : null;
    if (project == null || typeof project.project !== "string") {
      return yield* Effect.fail(new CliError({ code: 1, message: `scratchwork ${command}: invalid server response` }));
    }
    return { project: project.project };
  });
}

/** Fails with a context-prefixed CliError. */
function apiFail(context: string, message: string): Effect.Effect<never, CliError> {
  return Effect.fail(new CliError({ code: 1, message: `${context}: ${message}` }));
}
