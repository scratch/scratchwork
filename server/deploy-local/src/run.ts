import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { BunRuntime } from "@effect/platform-bun";
import {
  AuthLive,
  LocalObjectStorageLive,
  MemoryPrimitiveDbLive,
  ServerConfig,
  SiteStoreLive,
  app,
  makeServerConfigLayer,
  type EnvVars,
} from "@scratchwork/server-core";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { serverConfigEnvEntries, type ScratchworkServerConfig } from "@scratchwork/server-core/deploy/server-settings";

/** Options for a local run: the deploy project's `server` settings plus an env override
 * for tests. Using the shared config shape lets a deploy project run one config module
 * both in the cloud and locally. */
export interface RunLocalServerOptions {
  readonly server: ScratchworkServerConfig;
  readonly processEnv?: EnvVars;
}

/**
 * Runs the Scratchwork server locally with the given server settings, local file storage,
 * and an in-memory database. Environment variables take precedence over `server` settings,
 * which take precedence over local defaults. The configured app/content *domains* are not
 * used as origins — a local run always serves loopback URLs. When the settings declare
 * distinct app and content domains, the local run mirrors that split on one port with
 * `http://localhost:<port>` (app — plain localhost keeps Google OAuth redirect URIs valid)
 * and `http://pages.localhost:<port>` (content — *.localhost is loopback per RFC 6761),
 * so host-separated behavior such as the private-content cookie handoff works the same
 * way locally.
 *
 * Returns immediately after handing the server program to `BunRuntime.runMain`, which
 * takes over the process (keeps it alive, installs signal handlers) for the lifetime of
 * the server.
 */
export function runLocalServer(options: RunLocalServerOptions): void {
  const processEnv = options.processEnv ?? (process.env as EnvVars);
  const server = options.server;
  const localPort = processEnv.PORT ?? processEnv.SCRATCHWORK_PORT ?? "43118";
  const splitHosts = server.appDomain != null && server.contentDomain != null && server.appDomain !== server.contentDomain;
  const appUrl = processEnv.SCRATCHWORK_APP_URL ?? `http://localhost:${localPort}`;
  // A configured homepage gets its own loopback origin, mirroring the cloud host split,
  // so home-domain routing and the "/"-scoped access cookie work the same way locally.
  const homepageUrl = processEnv.SCRATCHWORK_HOMEPAGE_DOMAINS
    ?? (server.homepageProject == null ? undefined : `http://home.localhost:${localPort}`);
  const env: EnvVars = {
    ...processEnv,
    ...serverSettingsEnv(server, processEnv),
    SCRATCHWORK_APP_URL: appUrl,
    SCRATCHWORK_CONTENT_URL: processEnv.SCRATCHWORK_CONTENT_URL ?? (splitHosts ? `http://pages.localhost:${localPort}` : appUrl),
    ...(homepageUrl == null ? {} : { SCRATCHWORK_HOMEPAGE_DOMAINS: homepageUrl }),
    PORT: localPort,
  };

  const storageDirectory = env.SCRATCHWORK_STORAGE_DIR ?? ".scratchwork-local-data";

  // BunHttpServer.layerContext already provides FileSystem and Path via BunContext.
  const BaseLayer = Layer.mergeAll(
    BunHttpServer.layerContext,
    makeServerConfigLayer(env),
  );

  const StorageLayer = Layer.provideMerge(
    LocalObjectStorageLive(storageDirectory),
    BaseLayer,
  );

  const MainLayer = Layer.provideMerge(
    Layer.mergeAll(AuthLive, SiteStoreLive),
    Layer.mergeAll(StorageLayer, MemoryPrimitiveDbLive()),
  );

  const program = Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const httpServer = yield* BunHttpServer.make({ port: config.port, idleTimeout: 60 });
      yield* httpServer.serve(app);
      const resolvedAppUrl = config.appUrl ?? `http://localhost:${config.port}`;
      const resolvedContentUrl = config.contentUrl ?? resolvedAppUrl;
      yield* Console.log(
        [
          "scratchwork local deploy",
          `app      ${resolvedAppUrl}`,
          `content  ${resolvedContentUrl}`,
          ...(config.homepageUrls.length === 0 ? [] : [`home     ${config.homepageUrls[0]} (project "${config.homepageProject}")`]),
          `storage  local:${storageDirectory}`,
        ].join("\n"),
      );
      return yield* Effect.never;
    }),
  );

  program.pipe(Effect.provide(MainLayer), BunRuntime.runMain);
}

/** Maps server settings onto their environment variables, keeping any already set. */
function serverSettingsEnv(server: ScratchworkServerConfig, processEnv: EnvVars): EnvVars {
  const env: Record<string, string | undefined> = {};
  for (const entry of serverConfigEnvEntries) {
    const resolved = processEnv[entry.name] ?? entry.value(server);
    if (resolved != null) env[entry.name] = resolved;
  }
  return env;
}
