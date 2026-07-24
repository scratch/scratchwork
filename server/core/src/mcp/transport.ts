/**
 * The /mcp endpoint: a deliberately stateless MCP streamable-HTTP transport.
 * Every response is a single application/json message (the spec's permitted
 * alternative to an SSE stream), no Mcp-Session-Id is ever issued, and every
 * POST is self-contained — which is exactly what the Lambda and Workers
 * deploy targets require, where consecutive calls can land on different
 * instances. Clients on both supported protocol revisions run statelessly
 * against a server that omits the session header.
 *
 * Hand-rolled rather than delegated to @effect/ai's McpServer (invariant 1
 * judgment call): that layer keeps per-session state in memory and routes
 * through @effect/platform HttpRouter, neither of which fits this server's
 * stateless serverless targets or its policy-registry dispatch; the stateless
 * tools-only subset implemented here is five methods over Effect Schemas.
 *
 * Security posture: bearer-only (never cookies) via the requireMcpUser
 * chokepoint, after the same cross-origin rejection every API route applies —
 * non-browser MCP clients send no Origin header and pass; a browser page on a
 * foreign origin is rejected, which also covers the spec's DNS-rebinding
 * guidance. Tool authorization is the endpoint policy registry, reached only
 * through invokeEndpoint (invariant 4).
 */
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readJsonBody, type RouteError, type RouteServices } from "../api-routes.ts";
import { requireMcpUser } from "../auth.ts";
import { ServerConfig } from "../config.ts";
import { appBaseUrl, HttpError, jsonResponse, rejectCrossOriginApiRequest, securityHeaders } from "../http.ts";
import { mcpResourceUrl, mcpUnauthorizedResponse } from "../mcp-oauth-routes.ts";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  jsonRpcError,
  jsonRpcResult,
  JsonRpcRequestSchema,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  type JsonRpcId,
} from "./jsonrpc.ts";
import { callMcpTool, MCP_TOOL_LISTING, type McpToolContext } from "./tools.ts";

/** Protocol revisions this transport accepts, newest first. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** Identifies the MCP surface itself (not the package release): bump when the
 * advertised tool surface changes materially. Deploy targets cannot read
 * package.json at runtime, so this is a deliberate constant. */
const MCP_SERVER_INFO = { name: "scratchwork", version: "1.0.0" } as const;

/** Guidance MCP clients surface to their model alongside the tool list. */
const MCP_INSTRUCTIONS =
  "Scratchwork publishes static HTML and Markdown as shareable pages. " +
  "Use the publish tool with the complete file set of a project; the response carries the live URL. " +
  "Projects start private — pass isPublic true to publish publicly, and share_project to grant specific people access.";

/** The /mcp request body cap: the publish endpoint's cap plus headroom for
 * the JSON-RPC envelope (base64 file arguments match the HTTP encoding, so
 * the same content fits both transports). The authoritative content limits —
 * file count and byte caps — run inside the publish handler regardless. */
export const MAX_MCP_BODY_BYTES = 34 * 1024 * 1024;
const MCP_BODY_LIMIT = { maxBytes: MAX_MCP_BODY_BYTES, message: "Request body is too large" };

/** initialize params: only the protocol version matters to a stateless server. */
const InitializeParamsSchema = Schema.Struct({
  protocolVersion: Schema.optional(Schema.String),
});

/** tools/call params. */
const ToolCallParamsSchema = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Unknown),
});

/** Handles every request to /mcp. */
export function dispatchMcpRoute(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, RouteError, RouteServices> {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));

    // No server-initiated stream is offered and no session exists to delete.
    if (request.method !== "POST") {
      return yield* Effect.fail(new HttpError({ status: 405, message: "Method not allowed" }));
    }

    const user = yield* requireMcpUser(request, mcpResourceUrl(request, config), config.auth).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (user == null) return mcpUnauthorizedResponse(request, config);

    // An explicit unsupported protocol version header is a client bug worth a
    // hard error; an absent header reads as the older revision, per spec.
    const versionHeader = request.headers["mcp-protocol-version"];
    if (versionHeader != null && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(versionHeader)) {
      return jsonResponse({ error: `Unsupported MCP-Protocol-Version: ${versionHeader}` }, 400);
    }

    // An oversized body stays an HTTP 413; only a JSON parse failure becomes
    // the JSON-RPC parse error.
    const body = yield* readJsonBody(request, MCP_BODY_LIMIT).pipe(
      Effect.catchTag("HttpError", (error) =>
        error.status === 400 ? Effect.succeed(PARSE_FAILED) : Effect.fail(error)),
    );
    if (body === PARSE_FAILED) {
      return rpcResponse(jsonRpcError(null, PARSE_ERROR, "Request body is not valid JSON"));
    }
    if (Array.isArray(body)) {
      return rpcResponse(jsonRpcError(null, INVALID_REQUEST, "JSON-RPC batching is not supported"));
    }
    const message = yield* Schema.decodeUnknown(JsonRpcRequestSchema)(body).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (message == null) {
      return rpcResponse(jsonRpcError(null, INVALID_REQUEST, "Malformed JSON-RPC request"));
    }

    // Notifications (no id) are acknowledged and never answered.
    if (message.id === undefined) {
      return HttpServerResponse.empty({ status: 202, headers: securityHeaders() });
    }

    return yield* handleRpc(message.id, message.method, message.params, { request, url, user });
  });
}

/** Sentinel distinguishing an unparsable body from any legal JSON value. */
const PARSE_FAILED: unique symbol = Symbol("mcp-parse-failed");

/** Dispatches one JSON-RPC method. */
function handleRpc(
  id: JsonRpcId,
  method: string,
  params: unknown,
  context: McpToolContext,
): Effect.Effect<HttpServerResponse.HttpServerResponse, RouteError, RouteServices> {
  return Effect.gen(function* () {
    switch (method) {
      case "initialize": {
        const requested = yield* Schema.decodeUnknown(InitializeParamsSchema)(params ?? {}).pipe(
          Effect.orElseSucceed(() => ({ protocolVersion: undefined })),
        );
        const negotiated = requested.protocolVersion != null &&
            (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested.protocolVersion)
          ? requested.protocolVersion
          : LATEST_PROTOCOL_VERSION;
        // Deliberately no Mcp-Session-Id header: its absence is what tells
        // clients this server is stateless.
        return rpcResponse(jsonRpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        }));
      }
      case "ping":
        return rpcResponse(jsonRpcResult(id, {}));
      case "tools/list":
        return rpcResponse(jsonRpcResult(id, { tools: MCP_TOOL_LISTING }));
      case "tools/call": {
        const call = yield* Schema.decodeUnknown(ToolCallParamsSchema)(params ?? {}).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (call == null) {
          return rpcResponse(jsonRpcError(id, INVALID_PARAMS, "tools/call requires a tool name"));
        }
        return yield* runToolCall(id, call.name, call.arguments, context);
      }
      default:
        return rpcResponse(jsonRpcError(id, METHOD_NOT_FOUND, `Unknown method: ${method}`));
    }
  });
}

/** Executes one tool call. Domain failures — denied roles, masked projects,
 * validation inside the endpoint — are successful JSON-RPC responses carrying
 * `isError: true`, exactly the message the HTTP route would emit, so the
 * masking semantics of the policy registry survive the transport unchanged.
 * Unknown tools and argument-shape failures are protocol errors (-32602). */
function runToolCall(
  id: JsonRpcId,
  name: string,
  args: unknown,
  context: McpToolContext,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, RouteServices> {
  return callMcpTool(name, args, context).pipe(
    Effect.map((structured) =>
      rpcResponse(jsonRpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(structured) }],
        structuredContent: structured,
      }))),
    Effect.catchTags({
      McpToolArgsError: (error) =>
        Effect.succeed(rpcResponse(jsonRpcError(id, INVALID_PARAMS, error.message))),
      HttpError: (error) => Effect.succeed(toolErrorResponse(id, error.status, error.message)),
      AuthError: (error) => Effect.succeed(toolErrorResponse(id, error.status, error.message)),
      SiteStoreError: (error) => Effect.succeed(toolErrorResponse(id, error.status, error.message)),
      StorageError: () => Effect.succeed(toolErrorResponse(id, 500, "Storage operation failed")),
    }),
    Effect.catchAllDefect(() =>
      Effect.succeed(rpcResponse(jsonRpcError(id, INTERNAL_ERROR, "Internal error")))),
  );
}

/** A tool-level failure as the spec shapes it: a successful tools/call result
 * with isError set, carrying the same status and message as the HTTP route. */
function toolErrorResponse(id: JsonRpcId, status: number, message: string): HttpServerResponse.HttpServerResponse {
  return rpcResponse(jsonRpcResult(id, {
    content: [{ type: "text", text: `${status}: ${message}` }],
    isError: true,
  }));
}

/** Every JSON-RPC message rides an HTTP 200 with the standard API headers. */
function rpcResponse(body: unknown): HttpServerResponse.HttpServerResponse {
  return jsonResponse(body, 200);
}
