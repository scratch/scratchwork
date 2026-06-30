import { describe, expect, test } from "bun:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { eventToRequest, responseToResult } from "../src/handler";

describe("AWS handler adapter", () => {
  test("merges API Gateway cookies into the Cookie header", async () => {
    const request = eventToRequest(event({
      headers: { host: "lambda.test", cookie: "a=1" },
      cookies: ["b=2", "c=3"],
      rawPath: "/api/me",
    }));

    expect(request.url).toBe("https://lambda.test/api/me");
    expect(request.headers.get("cookie")).toBe("a=1; b=2; c=3");
  });

  test("does not trust x-forwarded-host over host", () => {
    const request = eventToRequest(event({
      headers: { host: "real.test", "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" },
      rawPath: "/health",
    }));

    expect(request.url).toBe("https://real.test/health");
  });

  test("converts set-cookie to Lambda cookies", async () => {
    const result = await responseToResult(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "session=1; Path=/",
      },
    }));

    expect(result.statusCode).toBe(200);
    expect(result.isBase64Encoded).toBe(false);
    expect(result.cookies).toEqual(["session=1; Path=/"]);
    expect(result.headers?.["set-cookie"]).toBeUndefined();
  });

  test("base64 encodes binary responses", async () => {
    const result = await responseToResult(new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    }));

    expect(result.isBase64Encoded).toBe(true);
    expect(result.body).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });
});

/** Builds a minimal API Gateway v2 event for adapter tests. */
function event(overrides: Partial<APIGatewayProxyEventV2>): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    cookies: undefined,
    headers: {},
    requestContext: {
      accountId: "123",
      apiId: "api",
      domainName: "lambda.test",
      domainPrefix: "lambda",
      http: {
        method: "GET",
        path: overrides.rawPath ?? "/",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test",
      },
      requestId: "request",
      routeKey: "$default",
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2;
}
