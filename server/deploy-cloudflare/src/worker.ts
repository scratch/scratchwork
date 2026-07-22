import * as HttpApp from "@effect/platform/HttpApp";
import { AuthLive, app, makeServerConfigLayer, SiteStoreLive, type EnvVars } from "@scratchwork/server-core";
import * as Layer from "effect/Layer";
import { D1PrimitiveDbLive, type D1DatabaseBinding } from "./d1-db.ts";
import { R2ObjectStorageLive, type R2BucketBinding } from "./r2-storage.ts";

/** The Worker environment: the two service bindings plus string config vars. */
interface CloudflareEnv extends Record<string, R2BucketBinding | D1DatabaseBinding | string | undefined> {
  readonly SCRATCHWORK_R2: R2BucketBinding;
  readonly SCRATCHWORK_D1: D1DatabaseBinding;
}

/** The subset of Cloudflare's execution context the fetch signature requires. */
interface ExecutionContextBinding {
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly passThroughOnException: () => void;
}

/** One handler per environment-binding object, so layers build once per isolate. */
const handlers = new WeakMap<CloudflareEnv, (request: Request) => Promise<Response>>();

/** The Worker entry point. No failure may escape fetch: an exception that leaves the
 * Worker renders Cloudflare's opaque 1101 error page for every request, so anything the
 * app's own error handling did not catch — most importantly a service layer that fails
 * to build, e.g. malformed SCRATCHWORK_* config — is logged for Workers Logs and
 * answered with a plain 500. */
export default {
  async fetch(request: Request, env: CloudflareEnv, _context: ExecutionContextBinding): Promise<Response> {
    try {
      return await handlerFor(env)(request);
    } catch (error) {
      console.error("scratchwork worker: unhandled error", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  },
};

/** Builds and caches one Effect web handler per Cloudflare environment binding set. */
function handlerFor(env: CloudflareEnv): (request: Request) => Promise<Response> {
  const cached = handlers.get(env);
  if (cached != null) return cached;

  const serverEnv = envVarsFromCloudflare(env);
  const layer = Layer.provideMerge(
    Layer.mergeAll(AuthLive, SiteStoreLive),
    Layer.mergeAll(R2ObjectStorageLive(env.SCRATCHWORK_R2), D1PrimitiveDbLive(env.SCRATCHWORK_D1), makeServerConfigLayer(serverEnv)),
  );
  const web = HttpApp.toWebHandlerLayer(app, layer);
  handlers.set(env, web.handler);
  return web.handler;
}

/** Copies the string environment vars (PORT, SCRATCHWORK_*, GOOGLE_*) for server config, excluding the R2/D1 service bindings. */
export function envVarsFromCloudflare(env: CloudflareEnv): EnvVars {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (key === "PORT" || key.startsWith("SCRATCHWORK_") || key.startsWith("GOOGLE_")) {
      vars[key] = value;
    }
  }
  return vars;
}
