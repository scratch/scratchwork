import * as HttpApp from "@effect/platform/HttpApp";
import { AuthLive, app, makeServerConfigLayer, SiteStoreLive, type EnvVars } from "@scratchwork/server-core";
import * as Layer from "effect/Layer";
import { D1PrimitiveDbLive, type D1DatabaseBinding } from "./d1-db";
import { R2ObjectStorageLive, type R2BucketBinding } from "./r2-storage";

interface CloudflareEnv extends Record<string, R2BucketBinding | D1DatabaseBinding | string | undefined> {
  readonly SCRATCHWORK_R2: R2BucketBinding;
  readonly SCRATCHWORK_D1: D1DatabaseBinding;
}

interface ExecutionContextBinding {
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly passThroughOnException: () => void;
}

const handlers = new WeakMap<CloudflareEnv, (request: Request) => Promise<Response>>();

export default {
  fetch(request: Request, env: CloudflareEnv, _context: ExecutionContextBinding): Promise<Response> {
    return handlerFor(env)(request);
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

/** Copies string Cloudflare bindings that should be visible to server config. */
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
