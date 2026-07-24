/**
 * JSON-RPC 2.0 framing for the /mcp endpoint: the request envelope schema and
 * the response/error builders. Only the stateless subset MCP needs lives here
 * — single requests and notifications; batches are deliberately rejected by
 * the transport (the 2025-06-18 MCP revision removed them).
 */
import * as Schema from "effect/Schema";

/** JSON-RPC 2.0 error codes the transport emits. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** A JSON-RPC request id. Null is legal on the wire (and required on the
 * error response to an unparsable request). */
export const JsonRpcIdSchema = Schema.Union(Schema.String, Schema.Number, Schema.Null);

/** The decoded request id. */
export type JsonRpcId = typeof JsonRpcIdSchema.Type;

/** One JSON-RPC 2.0 request or notification (no `id` member). Decoded
 * tolerantly — this is the one wire shape where unknown members are expected
 * (`_meta`, future protocol fields) rather than protocol drift. */
export const JsonRpcRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(JsonRpcIdSchema),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});

/** The decoded request envelope. */
export type JsonRpcRequest = typeof JsonRpcRequestSchema.Type;

/** Builds a JSON-RPC success response. */
export function jsonRpcResult(id: JsonRpcId, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

/** Builds a JSON-RPC error response. */
export function jsonRpcError(id: JsonRpcId, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
