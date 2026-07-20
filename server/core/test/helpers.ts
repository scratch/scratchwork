import * as HttpApp from "@effect/platform/HttpApp";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Encoding from "effect/Encoding";
import { app } from "../src/app";
import { Auth, AuthError, AuthLive, type AuthShape, type AuthUser } from "../src/auth";
import { ServerConfig, type ServerConfigShape } from "../src/config";
import { MemoryPrimitiveDbLive, PrimitiveDb } from "../src/db";
import { SiteStoreLive } from "../src/site-store";
import { ObjectStorage, StorageConflict, StorageError, safeObjectKey, type ObjectStorageShape, type StoredObject } from "../src/storage";

/** One object held by the in-memory test storage. */
export interface MemoryStoredObject {
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly etag: string;
}

/** Builds a publish bundle from test file contents. */
export function bundle(files: Record<string, string | Uint8Array>) {
  return {
    version: 1,
    files: Object.entries(files).map(([path, value]) => ({
      path,
      contentBase64: Encoding.encodeBase64(typeof value === "string" ? new TextEncoder().encode(value) : value),
    })),
  };
}

/** Creates a Web handler for the core app with test layers. */
export async function appHandler(options: {
  readonly config?: Partial<ServerConfigShape>;
  readonly storage?: Map<string, MemoryStoredObject>;
  readonly db?: Layer.Layer<PrimitiveDb>;
  readonly auth?: Layer.Layer<Auth>;
} = {}) {
  const config: ServerConfigShape = {
    port: 3001,
    appUrl: "https://scratch.test",
    contentUrl: "https://scratch.test",
    allowPublicProjects: true,
    allowedShareDomains: new Set(),
    usersCanSetProjectNames: true,
    auth: {
      mode: "oauth",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      sessionSecret: "test-session-secret-test-session-secret",
      allowedUsers: "public",
      sessionTtlSeconds: 60,
    },
    ...options.config,
    homepageUrls: options.config?.homepageUrls ?? [],
  };
  const base = Layer.mergeAll(
    Layer.succeed(ServerConfig, ServerConfig.of(config)),
    memoryStorageLayer(options.storage),
    options.db ?? MemoryPrimitiveDbLive(),
  );
  const services = Layer.provideMerge(
    Layer.mergeAll(options.auth ?? AuthLive, SiteStoreLive),
    base,
  );
  return HttpApp.toWebHandlerLayer(app, services).handler;
}

/** Provides in-memory object storage for app tests. */
export function memoryStorageLayer(
  map = new Map<string, MemoryStoredObject>(),
): Layer.Layer<ObjectStorage> {
  return Layer.succeed(ObjectStorage, ObjectStorage.of(memoryStorage(map)));
}

/** Provides deterministic auth behavior for app tests. */
export function testAuth(user: AuthUser | null, apiUser = user): Layer.Layer<Auth> {
  const shape: AuthShape = {
    currentUser: () => Effect.succeed(user),
    requireApiUser: () => apiUser == null
      ? Effect.fail(new AuthError({ status: 401, message: "Authentication required" }))
      : Effect.succeed(apiUser),
    login: () => Effect.succeed(HttpServerResponse.redirect("/auth/login")),
    callback: () => Effect.succeed(HttpServerResponse.redirect("/")),
    logout: () => HttpServerResponse.redirect("/"),
    issueProjectAccessToken: () => Effect.succeed("project-access-token"),
    verifyProjectAccessToken: () => apiUser == null
      ? Effect.succeed(null)
      : Effect.succeed(apiUser),
  };
  return Layer.succeed(Auth, Auth.of(shape));
}

/** Reads a test response body as JSON. */
export async function json(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

/** Implements ObjectStorage against a mutable test map. */
export function memoryStorage(map: Map<string, MemoryStoredObject>): ObjectStorageShape {
  const getObject: ObjectStorageShape["getObject"] = (key) =>
    Effect.suspend(() => {
      if (!safeObjectKey(key)) {
        return Effect.fail(new StorageError({ message: `Invalid object key: ${key}` }));
      }
      const object = map.get(key);
      return Effect.succeed(
        object == null
          ? null
          : {
              key,
              body: object.body.slice(),
              contentType: object.contentType,
              etag: object.etag,
            } satisfies StoredObject,
      );
    });

  const putObject: ObjectStorageShape["putObject"] = (key, value, options) =>
    Effect.tryPromise({
      try: async () => {
        if (!safeObjectKey(key)) throw new StorageError({ message: `Invalid object key: ${key}` });
        const body = value.slice();
        // Hash before the precondition check: an await between check and set
        // would let concurrent conditional writes all pass the check.
        const etag = Encoding.encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)));
        const existing = map.get(key);
        if (options?.ifNoneMatch === "*" && existing != null) {
          throw new StorageConflict({ key, message: `Object already exists: ${key}` });
        }
        if (options?.ifMatch != null && existing?.etag !== options.ifMatch) {
          throw new StorageConflict({ key, message: `Object ETag mismatch: ${key}` });
        }
        map.set(key, { body, contentType: options?.contentType, etag });
        return { etag };
      },
      catch: (cause) => cause as StorageError | StorageConflict,
    });

  return {
    getObject,
    putObject,
    putText: (key, value, options) => putObject(key, new TextEncoder().encode(value), options),
  };
}
