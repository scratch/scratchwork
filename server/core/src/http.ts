import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Data from "effect/Data";

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
