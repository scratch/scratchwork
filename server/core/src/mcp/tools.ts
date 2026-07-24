/**
 * The MCP tool registry: every tool wraps exactly one contract endpoint at
 * CLI-operation altitude and executes it through invokeEndpoint, so a tool's
 * security policy IS the endpoint's API_POLICY entry — auth, minimum role,
 * masking, and strict decoding are inherited, never reimplemented (invariant
 * 4). Tool argument schemas are Effect Schemas; the JSON Schema advertised by
 * tools/list is derived from the same object that validates arguments, so the
 * two cannot drift.
 *
 * Deliberately deferred tools: `resolve` (agents rarely hold only a content
 * URL; trivial to add through this registry later) and a clone/bundle tool
 * (base64 bundles in tool results are token-hostile — revisit with MCP
 * resources).
 */
import type * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as JSONSchema from "effect/JSONSchema";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import {
  MeResponseSchema,
  OkResponseSchema,
  ProjectIdentifierSchema,
  ProjectResponseSchema,
  ProjectsListResponseSchema,
  PublishResponseSchema,
  ShareResponseSchema,
  type ScratchworkEndpointName,
} from "@scratchwork/shared/publish/api";
import { PUBLISH_BUNDLE_VERSION } from "@scratchwork/shared/publish/bundle";
import { decodedBase64ByteLength } from "@scratchwork/shared/encoding/base64";
import { isSafeSitePath } from "@scratchwork/shared/site/paths";
import { invokeEndpoint, type RouteError, type RouteServices } from "../api-routes.ts";
import type { AuthUser } from "../auth.ts";
import { HttpError } from "../http.ts";

/** What the transport hands every tool execution: the authenticated /mcp
 * principal plus the request/url the endpoint handlers derive origins from. */
export interface McpToolContext {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  readonly user: AuthUser;
}

/** One registered MCP tool. `endpoint` types the backing contract endpoint,
 * so a tool over a nonexistent endpoint cannot compile; `execute` receives
 * the tool's decoded arguments. */
interface McpToolDef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly endpoint: ScratchworkEndpointName;
  readonly annotations: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
  };
  readonly argsSchema: Schema.Schema.Any;
  readonly outputSchema: Schema.Schema.Any;
  readonly execute: (args: never, context: McpToolContext) => Effect.Effect<unknown, RouteError, RouteServices>;
}

/** One file in a publish tool call: text content for the common case, base64
 * for binary assets — exactly one of the two. */
const McpPublishFileSchema = Schema.Struct({
  path: Schema.String.pipe(
    Schema.filter((path) => isSafeSitePath(path) || "Invalid site path"),
    Schema.annotations({ description: "Site-relative file path, like \"index.html\" or \"notes/day-1.md\"" }),
  ),
  content: Schema.optional(Schema.String.pipe(
    Schema.annotations({ description: "UTF-8 text content of the file" }),
  )),
  contentBase64: Schema.optional(Schema.String.pipe(
    Schema.filter((content) => decodedBase64ByteLength(content) != null || "Invalid base64 content"),
    Schema.annotations({ description: "Base64-encoded binary content of the file" }),
  )),
}).pipe(
  Schema.filter((file) =>
    (file.content == null) !== (file.contentBase64 == null) ||
    "Provide exactly one of content or contentBase64",
  ),
);

/** Arguments of the publish tool. */
const PublishArgsSchema = Schema.Struct({
  files: Schema.Array(McpPublishFileSchema).pipe(
    Schema.minItems(1),
    Schema.annotations({
      title: "files",
      description: "Every file of the site — a publish replaces the project's whole file set",
    }),
  ),
  project: Schema.optional(ProjectIdentifierSchema.pipe(
    Schema.annotations({ description: "Project name. Omit on first publish to let the server assign one; pass an existing name to update it" }),
  )),
  openPath: Schema.optional(Schema.String.pipe(
    Schema.annotations({ description: "Path the project's URL should open, like \"/\" or \"/report.html\"" }),
  )),
  isPublic: Schema.optional(Schema.Boolean.pipe(
    Schema.annotations({ description: "true publishes publicly, false makes the project private; omitted keeps an existing project's setting (new projects start private)" }),
  )),
});

/** A bare `{ project }` argument object. */
const ProjectArgsSchema = Schema.Struct({
  project: ProjectIdentifierSchema.pipe(Schema.annotations({ description: "The project name" })),
});

/** Arguments of the share tool. */
const ShareArgsSchema = Schema.Struct({
  project: ProjectIdentifierSchema.pipe(Schema.annotations({ description: "The project name" })),
  role: Schema.optional(Schema.Literal("read", "write", "admin").pipe(
    Schema.annotations({ description: "Role granted to the added targets (default read)" }),
  )),
  add: Schema.optional(Schema.Array(Schema.String).pipe(
    Schema.annotations({ description: "Email addresses or @domain groups to grant access" }),
  )),
  remove: Schema.optional(Schema.Array(Schema.String).pipe(
    Schema.annotations({ description: "Email addresses or @domain groups to revoke" }),
  )),
});

/** No-argument tools. The explicit jsonSchema annotation pins the derived
 * shape to a plain object schema (an unannotated empty struct derives to
 * "object or array", which MCP clients reject as a tool inputSchema). */
const EmptyArgsSchema = Schema.Struct({}).annotations({
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
});

/** Runs one contract endpoint from a tool execution. */
function invoke<Name extends ScratchworkEndpointName>(
  name: Name,
  context: McpToolContext,
  input: { readonly project?: string; readonly payload?: unknown },
) {
  return invokeEndpoint(name, {
    request: context.request,
    url: context.url,
    user: context.user,
    project: input.project ?? null,
    args: Effect.succeed(input.payload),
  });
}

/** Builds the publish endpoint's body from tool-call files: text content is
 * base64-encoded here, then the whole bundle re-runs the shared
 * PublishBundleSchema decode and the server's publish caps unchanged. */
function publishPayload(args: typeof PublishArgsSchema.Type): unknown {
  return {
    bundle: {
      version: PUBLISH_BUNDLE_VERSION,
      files: args.files.map((file) => ({
        path: file.path,
        contentBase64: file.contentBase64 ?? Encoding.encodeBase64(new TextEncoder().encode(file.content ?? "")),
      })),
    },
    ...(args.project == null ? {} : { project: args.project }),
    ...(args.openPath == null ? {} : { openPath: args.openPath }),
    ...(args.isPublic == null ? {} : { isPublic: args.isPublic }),
  };
}

/** Every tool the /mcp endpoint serves. */
export const MCP_TOOLS: ReadonlyArray<McpToolDef> = [
  {
    name: "publish",
    title: "Publish a project",
    description:
      "Publish (or update) a Scratchwork project from a set of files and return its URL. " +
      "Send the complete file set — a publish replaces the project's previous contents. " +
      "HTML files are served as pages; Markdown files render through the Scratchwork viewer.",
    endpoint: "publish",
    annotations: {},
    argsSchema: PublishArgsSchema,
    outputSchema: PublishResponseSchema,
    execute: (args: typeof PublishArgsSchema.Type, context) =>
      invoke("publish", context, { payload: publishPayload(args) }),
  },
  {
    name: "list_projects",
    title: "List projects",
    description: "List every Scratchwork project the signed-in account can read, with URLs and metadata.",
    endpoint: "projects-list",
    annotations: { readOnlyHint: true },
    argsSchema: EmptyArgsSchema,
    outputSchema: ProjectsListResponseSchema,
    execute: (_args, context) => invoke("projects-list", context, {}),
  },
  {
    name: "project_info",
    title: "Get project info",
    description: "Fetch one project's summary: visibility, owner, URL, file count, and timestamps.",
    endpoint: "project-info",
    annotations: { readOnlyHint: true },
    argsSchema: ProjectArgsSchema,
    outputSchema: ProjectResponseSchema,
    execute: (args: typeof ProjectArgsSchema.Type, context) =>
      invoke("project-info", context, { project: args.project }),
  },
  {
    name: "share_project",
    title: "Share a project",
    description:
      "Grant or revoke access to a project: add email addresses or @domain groups at a role " +
      "(read, write, or admin), or remove existing grants. Requires admin access to the project.",
    endpoint: "project-share",
    annotations: {},
    argsSchema: ShareArgsSchema,
    outputSchema: ShareResponseSchema,
    execute: (args: typeof ShareArgsSchema.Type, context) =>
      invoke("project-share", context, {
        project: args.project,
        payload: {
          ...(args.role == null ? {} : { role: args.role }),
          ...(args.add == null ? {} : { add: args.add }),
          ...(args.remove == null ? {} : { remove: args.remove }),
        },
      }),
  },
  {
    name: "unpublish_project",
    title: "Unpublish a project",
    description: "Make a project private: its content stays intact but stops being publicly reachable. Requires admin access.",
    endpoint: "project-unpublish",
    annotations: { destructiveHint: true, idempotentHint: true },
    argsSchema: ProjectArgsSchema,
    outputSchema: ProjectResponseSchema,
    execute: (args: typeof ProjectArgsSchema.Type, context) =>
      invoke("project-unpublish", context, { project: args.project }),
  },
  {
    name: "delete_project",
    title: "Delete a project",
    description: "Permanently delete a project and all of its content. Only the project owner can delete it.",
    endpoint: "project-delete",
    annotations: { destructiveHint: true },
    argsSchema: ProjectArgsSchema,
    outputSchema: OkResponseSchema,
    execute: (args: typeof ProjectArgsSchema.Type, context) =>
      invoke("project-delete", context, { project: args.project }),
  },
  {
    name: "whoami",
    title: "Show the signed-in account",
    description: "Report which Scratchwork account this connection is authenticated as.",
    endpoint: "me",
    annotations: { readOnlyHint: true },
    argsSchema: EmptyArgsSchema,
    outputSchema: MeResponseSchema,
    execute: (_args, context) => invoke("me", context, {}),
  },
] as ReadonlyArray<McpToolDef>;

/** The tools/list wire entries, with JSON Schemas derived from the same
 * Effect Schemas that validate calls. */
export const MCP_TOOL_LISTING: ReadonlyArray<unknown> = MCP_TOOLS.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: toJsonSchema(tool.argsSchema),
  outputSchema: toJsonSchema(tool.outputSchema),
  annotations: tool.annotations,
}));

/** Raised when a tools/call names an unknown tool or sends invalid arguments
 * — the transport maps it to JSON-RPC -32602. */
export class McpToolArgsError extends Data.TaggedError("McpToolArgsError")<{
  readonly message: string;
}> {}

/** Executes one tools/call: strict argument decode through the tool's schema,
 * the endpoint invocation, then the result encoded through the shared success
 * schema as the tool's structuredContent. */
export function callMcpTool(
  name: string,
  args: unknown,
  context: McpToolContext,
): Effect.Effect<unknown, McpToolArgsError | RouteError, RouteServices> {
  return Effect.gen(function* () {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
    if (tool == null) {
      return yield* Effect.fail(new McpToolArgsError({ message: `Unknown tool: ${name}` }));
    }
    const decoded = yield* Schema.decodeUnknown(tool.argsSchema as Schema.Schema<unknown, unknown>)(args ?? {}, {
      errors: "all",
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((error) => new McpToolArgsError({ message: ParseResult.TreeFormatter.formatErrorSync(error) })),
    );
    const result = yield* tool.execute(decoded as never, context);
    return yield* Schema.encodeUnknown(tool.outputSchema as Schema.Schema<unknown, unknown>)(result).pipe(
      Effect.mapError((cause) => new HttpError({ status: 500, message: "Could not encode the tool result", cause })),
    );
  });
}

/** Derives the advertised JSON Schema from an Effect Schema, dropping the
 * `$schema` marker MCP clients do not expect. */
function toJsonSchema(schema: Schema.Schema.Any): unknown {
  const { $schema: _dropped, ...rest } = JSONSchema.make(schema as Schema.Schema<unknown, unknown>) as unknown as {
    readonly $schema?: string;
    readonly [key: string]: unknown;
  };
  return rest;
}
