/*
 * Thin client for the Scratchwork auth API. Just fetch() — no dependencies.
 * One place builds auth headers; everything else is a small wrapper.
 *
 * Auth (buildHeaders): a stored/CI credential is { token, type, cfToken }.
 *   type "api_key" → X-Api-Key            (CI tokens, scratchwork_…)
 *   else           → Authorization: Bearer (session tokens; also legacy servers)
 *   cfToken        → cf-access-token        (Cloudflare Access mode)
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Auth, User, WhoamiResult } from "../types";

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly message: string;
  readonly status: number;
  readonly body?: unknown;
}> {}

export function buildHeaders(auth: Auth | null): Record<string, string> {
  const h: Record<string, string> = {};
  if (auth && auth.token) {
    if (auth.type === "api_key") h["X-Api-Key"] = auth.token;
    else h["Authorization"] = `Bearer ${auth.token}`;
    if (auth.cfToken) h["cf-access-token"] = auth.cfToken;
  }
  return h;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseResponse(res: Response): Effect.Effect<unknown, ApiError> {
  return Effect.tryPromise({
    try: () => res.text(),
    catch: (error) =>
      new ApiError({
        message: `Could not read server response: ${messageOf(error)}`,
        status: res.status,
      }),
  }).pipe(Effect.map(parseJson));
}

const base = (serverUrl: string) => serverUrl.replace(/\/+$/, "");

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { readonly message?: unknown })?.message;
  return typeof message === "string" ? message : String(error);
}

// Generic JSON request. Throws ApiError on a non-ok response.
function apiFetch<T>(
  serverUrl: string,
  path: string,
  {
    method = "GET",
    auth = null,
    json: jsonBody,
  }: {
    readonly method?: string;
    readonly auth?: Auth | null;
    readonly json?: unknown;
  } = {},
): Effect.Effect<T, ApiError> {
  const headers = buildHeaders(auth);
  let body: string | undefined;
  if (jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(jsonBody);
  }

  return Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${base(serverUrl)}${path}`, { method, headers, body, signal }),
      catch: (error) =>
        new ApiError({
          message: `Could not reach ${serverUrl}: ${messageOf(error)}`,
          status: 0,
        }),
    });
    const parsed = yield* parseResponse(res);
    if (!res.ok) {
      const error = parsedError(parsed) ?? `Server error (${res.status})`;
      return yield* Effect.fail(
        new ApiError({ message: error, status: res.status, body: parsed }),
      );
    }
    return parsed as T;
  });
}

function parsedError(parsed: unknown): string | null {
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    typeof parsed.error === "string"
  ) {
    return parsed.error;
  }
  return null;
}

// GET /api/whoami — { authRequired, authenticated, user? }.
export function whoami({
  serverUrl,
  auth,
}: {
  readonly serverUrl: string;
  readonly auth: Auth | null;
}): Effect.Effect<WhoamiResult, ApiError> {
  return apiFetch(serverUrl, "/api/whoami", { auth });
}

// GET /api/me — { user } (accounts mode). Throws 401 if not authenticated.
export function getCurrentUser({
  serverUrl,
  auth,
}: {
  readonly serverUrl: string;
  readonly auth: Auth;
}): Effect.Effect<{ readonly user: User }, ApiError> {
  return apiFetch(serverUrl, "/api/me", { auth });
}

// ---- device flow (fallback poll-based login) ----
export const startDeviceAuth = ({
  serverUrl,
}: {
  readonly serverUrl: string;
}): Effect.Effect<unknown, ApiError> =>
  apiFetch(serverUrl, "/api/login/device/start", { method: "POST", json: {} });

export function pollDeviceToken({
  serverUrl,
  deviceCode,
}: {
  readonly serverUrl: string;
  readonly deviceCode: string;
}): Effect.Effect<unknown, ApiError> {
  // Returns { access_token } or { error: 'authorization_pending' | ... }. The
  // poll endpoint uses non-2xx for pending, so swallow ApiError into its body.
  return apiFetch(serverUrl, "/api/login/device/token", {
    method: "POST",
    json: { device_code: deviceCode },
  }).pipe(
    Effect.catchAll((error) =>
      error.body && typeof error.body === "object"
        ? Effect.succeed(error.body)
        : Effect.fail(error),
    ),
  );
}
