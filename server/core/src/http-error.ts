import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class HttpError extends Data.TaggedError("HttpError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Creates a JSON response with common API security headers. */
export function jsonResponse(
  body: unknown,
  status: number,
): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return Effect.succeed(
    HttpServerResponse.unsafeJson(body, {
      status,
      headers: securityHeaders(),
    }),
  );
}

/** Creates the standard `{ error }` JSON response. */
export function errorJson(status: number, message: string): Effect.Effect<HttpServerResponse.HttpServerResponse> {
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
