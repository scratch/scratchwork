import * as HttpApp from "@effect/platform/HttpApp";
import { app, makeServerConfigLayer, type EnvVars } from "@scratchwork/server-core";
import * as Layer from "effect/Layer";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context as LambdaContext,
} from "aws-lambda";
import { AwsObjectStorageLive } from "./storage";

const env = process.env as EnvVars;
const MainLayer = Layer.mergeAll(makeServerConfigLayer(env), AwsObjectStorageLive(env));
const web = HttpApp.toWebHandlerLayer(app, MainLayer);

export async function handler(
  event: APIGatewayProxyEventV2,
  _context: LambdaContext,
): Promise<APIGatewayProxyStructuredResultV2> {
  const request = eventToRequest(event);
  const response = await web.handler(request);
  return responseToResult(response);
}

function eventToRequest(event: APIGatewayProxyEventV2): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value != null) headers.set(key, value);
  }

  const proto = firstHeader(event.headers, "x-forwarded-proto") ?? "https";
  const host = firstHeader(event.headers, "x-forwarded-host") ?? firstHeader(event.headers, "host") ?? event.requestContext.domainName;
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

async function responseToResult(response: Response): Promise<APIGatewayProxyStructuredResultV2> {
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

function firstHeader(headers: APIGatewayProxyEventV2["headers"], name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
}

function getSetCookie(headers: Headers): ReadonlyArray<string> {
  const withCookies = headers as Headers & { readonly getSetCookie?: () => ReadonlyArray<string> };
  return withCookies.getSetCookie?.() ?? [];
}

function isTextResponse(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("javascript") ||
    contentType.includes("xml") ||
    contentType.includes("svg")
  );
}
