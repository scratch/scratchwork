import * as HttpApp from "@effect/platform/HttpApp";
import { AuthLive, app, makeServerConfigLayer, SiteStoreLive, type EnvVars } from "@scratchwork/server-core";
import * as Layer from "effect/Layer";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context as LambdaContext,
} from "aws-lambda";
import { DynamoDbPrimitiveDbLive } from "./dynamodb-db";
import { S3ObjectStorageLive } from "./s3-storage";

const env = process.env as EnvVars;
/** The full service graph for the Lambda runtime, built from process.env. */
const MainLayer = Layer.provideMerge(
  Layer.mergeAll(AuthLive, SiteStoreLive),
  Layer.mergeAll(S3ObjectStorageLive(env), DynamoDbPrimitiveDbLive(env), makeServerConfigLayer(env)),
);

/** The core app as a Web fetch handler, built lazily inside the request guard so even a
 * handler-construction failure answers as a 500 instead of killing the invocation. */
let web: { readonly handler: (request: Request) => Promise<Response> } | null = null;

/** Handles one API Gateway v2 event with the shared server app. No failure may escape:
 * anything the app's own error handling did not catch — most importantly a service layer
 * that fails to build, e.g. malformed SCRATCHWORK_* config — is logged for CloudWatch
 * and answered with a plain 500. */
export async function handler(
  event: APIGatewayProxyEventV2,
  _context: LambdaContext,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    web ??= HttpApp.toWebHandlerLayer(app, MainLayer);
    const request = eventToRequest(event);
    const response = await web.handler(request);
    return responseToResult(response);
  } catch (error) {
    console.error("scratchwork handler: unhandled error", error);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Internal server error" }),
      isBase64Encoded: false,
    };
  }
}

/** Converts an API Gateway v2 event into a standard Web Request. */
export function eventToRequest(event: APIGatewayProxyEventV2): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value != null) headers.set(key, value);
  }
  const cookies = cookieHeaderFromEvent(event);
  if (cookies != null) headers.set("cookie", cookies);

  const proto = firstHeader(event.headers, "x-forwarded-proto") ?? "https";
  const host = firstHeader(event.headers, "host") ?? event.requestContext.domainName;
  const path = event.rawPath || event.requestContext.http.path || "/";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const method = event.requestContext.http.method;
  const url = `${proto}://${host}${path}${query}`;
  const body = event.body == null || method === "GET" || method === "HEAD"
    ? undefined
    : event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : event.body;

  return new Request(url, { body, headers, method });
}

/** Converts a standard Web Response into API Gateway's structured result. */
export async function responseToResult(response: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() !== "set-cookie") headers[key] = value;
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  const isText = isTextResponse(contentType);
  const cookies = getSetCookie(response.headers);

  return {
    statusCode: response.status,
    headers,
    cookies: cookies.length > 0 ? [...cookies] : undefined,
    body: isText ? bytes.toString("utf8") : bytes.toString("base64"),
    isBase64Encoded: !isText,
  };
}

/** Merges API Gateway's cookie array with any existing Cookie header. */
function cookieHeaderFromEvent(event: APIGatewayProxyEventV2): string | undefined {
  const eventCookies = event.cookies?.filter((cookie) => cookie !== "") ?? [];
  const headerCookie = firstHeader(event.headers, "cookie");
  if (headerCookie == null || headerCookie === "") return eventCookies.length === 0 ? undefined : eventCookies.join("; ");
  return eventCookies.length === 0 ? headerCookie : `${headerCookie}; ${eventCookies.join("; ")}`;
}

/** Finds a header value case-insensitively in API Gateway's header object. */
function firstHeader(headers: APIGatewayProxyEventV2["headers"], name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
}

/** Reads all Set-Cookie headers across runtimes with and without getSetCookie. */
function getSetCookie(headers: Headers): ReadonlyArray<string> {
  const withCookies = headers as Headers & { readonly getSetCookie?: () => ReadonlyArray<string> };
  const cookies = withCookies.getSetCookie?.();
  if (cookies != null && cookies.length > 0) return cookies;
  const cookie = headers.get("set-cookie");
  return cookie == null ? [] : [cookie];
}

/** Decides whether Lambda can return a response body as UTF-8 text. */
function isTextResponse(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("javascript") ||
    contentType.includes("xml") ||
    contentType.includes("svg")
  );
}
