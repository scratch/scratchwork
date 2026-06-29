import * as HttpApp from "@effect/platform/HttpApp";
import { app, makeServerConfigLayer, type EnvVars } from "@scratchwork/server-core";
import * as Layer from "effect/Layer";
import { R2ObjectStorageLive, type R2BucketBinding } from "./r2-storage";

interface CloudflareEnv {
  readonly SCRATCHWORK_R2: R2BucketBinding;
  readonly PORT?: string;
  readonly SCRATCHWORK_PORT?: string;
  readonly SCRATCHWORK_PUBLIC_URL?: string;
}

interface ExecutionContextBinding {
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly passThroughOnException: () => void;
}

const handlers = new WeakMap<R2BucketBinding, (request: Request) => Promise<Response>>();

export default {
  fetch(request: Request, env: CloudflareEnv, _context: ExecutionContextBinding): Promise<Response> {
    return handlerFor(env)(request);
  },
};

function handlerFor(env: CloudflareEnv): (request: Request) => Promise<Response> {
  const cached = handlers.get(env.SCRATCHWORK_R2);
  if (cached != null) return cached;

  const serverEnv: EnvVars = {
    PORT: env.PORT,
    SCRATCHWORK_PORT: env.SCRATCHWORK_PORT,
    SCRATCHWORK_PUBLIC_URL: env.SCRATCHWORK_PUBLIC_URL,
  };
  const layer = Layer.mergeAll(
    makeServerConfigLayer(serverEnv),
    R2ObjectStorageLive(env.SCRATCHWORK_R2),
  );
  const web = HttpApp.toWebHandlerLayer(app, layer);
  handlers.set(env.SCRATCHWORK_R2, web.handler);
  return web.handler;
}
