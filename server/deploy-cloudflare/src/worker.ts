import * as HttpApp from "@effect/platform/HttpApp";
import { AuthLive, app, makeServerConfigLayer, type EnvVars } from "@scratchwork/server-core";
import * as Layer from "effect/Layer";
import { R2ObjectStorageLive, type R2BucketBinding } from "./r2-storage";

interface CloudflareEnv {
  readonly SCRATCHWORK_R2: R2BucketBinding;
  readonly PORT?: string;
  readonly SCRATCHWORK_PORT?: string;
  readonly SCRATCHWORK_PUBLIC_URL?: string;
  readonly SCRATCHWORK_AUTH?: string;
  readonly SCRATCHWORK_GOOGLE_CLIENT_ID?: string;
  readonly SCRATCHWORK_GOOGLE_CLIENT_SECRET?: string;
  readonly SCRATCHWORK_SESSION_SECRET?: string;
  readonly SCRATCHWORK_AUTH_ALLOWED_EMAILS?: string;
  readonly SCRATCHWORK_AUTH_ALLOWED_DOMAINS?: string;
  readonly SCRATCHWORK_AUTH_SESSION_SECONDS?: string;
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

function handlerFor(env: CloudflareEnv): (request: Request) => Promise<Response> {
  const cached = handlers.get(env);
  if (cached != null) return cached;

  const serverEnv: EnvVars = {
    PORT: env.PORT,
    SCRATCHWORK_PORT: env.SCRATCHWORK_PORT,
    SCRATCHWORK_PUBLIC_URL: env.SCRATCHWORK_PUBLIC_URL,
    SCRATCHWORK_AUTH: env.SCRATCHWORK_AUTH,
    SCRATCHWORK_GOOGLE_CLIENT_ID: env.SCRATCHWORK_GOOGLE_CLIENT_ID,
    SCRATCHWORK_GOOGLE_CLIENT_SECRET: env.SCRATCHWORK_GOOGLE_CLIENT_SECRET,
    SCRATCHWORK_SESSION_SECRET: env.SCRATCHWORK_SESSION_SECRET,
    SCRATCHWORK_AUTH_ALLOWED_EMAILS: env.SCRATCHWORK_AUTH_ALLOWED_EMAILS,
    SCRATCHWORK_AUTH_ALLOWED_DOMAINS: env.SCRATCHWORK_AUTH_ALLOWED_DOMAINS,
    SCRATCHWORK_AUTH_SESSION_SECONDS: env.SCRATCHWORK_AUTH_SESSION_SECONDS,
  };
  const layer = Layer.provideMerge(
    Layer.mergeAll(R2ObjectStorageLive(env.SCRATCHWORK_R2), AuthLive),
    makeServerConfigLayer(serverEnv),
  );
  const web = HttpApp.toWebHandlerLayer(app, layer);
  handlers.set(env, web.handler);
  return web.handler;
}
