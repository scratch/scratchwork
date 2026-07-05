/**
 * Public API of the platform-neutral server core. Adapters compose the layers below and
 * hand `app` to their HTTP runtime. Backend-author toolkits (key validators, value codecs)
 * live on the "@scratchwork/server-core/db" and "/storage" subpaths.
 */

// The HTTP app — one Effect handling every request; provide the services below to run it.
export { app } from "./app";

// Server configuration, parsed from SCRATCHWORK_* environment variables.
export {
  makeServerConfigLayer,
  readServerConfig,
  ServerConfig,
  ServerConfigError,
  type AuthConfig,
  type EnvVars,
  type ServerConfigShape,
} from "./config";

// Google OAuth auth service and signed session tokens.
export { Auth, AuthError, AuthLive, createSessionToken, makeAuth, type AuthShape, type AuthUser } from "./auth";

// Access-group expressions ("public" | "private" | emails/@domains) and identifier helpers.
export {
  AccessGroupError,
  accessGroupIsSubset,
  accessGroupMatches,
  accessGroupUsesOnlyDomains,
  normalizeAccessGroup,
  isSafeProjectIdentifier,
  type AccessGroup,
  type AccessPrincipal,
} from "./access";

// Versioned JSON key-value contract with an in-memory implementation for tests/local runs.
export {
  MemoryPrimitiveDbLive,
  makeMemoryPrimitiveDb,
  PrimitiveDb,
  PrimitiveDbConflict,
  PrimitiveDbError,
  type JsonValue,
  type PrimitiveDbRecord,
  type PrimitiveDbShape,
} from "./db";

// Blob-store contract with a local-filesystem implementation.
export {
  LocalObjectStorageLive,
  ObjectStorage,
  StorageConflict,
  StorageError,
  type ObjectStorageShape,
  type PutObjectOptions,
  type PutObjectResult,
  type StoredObject,
} from "./storage";

// The site store: publishing, loading, and access policy over storage + db.
export {
  SiteStore,
  SiteStoreError,
  SiteStoreLive,
  canReadProject,
  canWriteProject,
  type LoadedSite,
  type PublishResult,
  type SiteStoreShape,
} from "./site-store";

// Persisted record shapes and route matching for published sites.
export { type SiteFileObject, type SiteRecord, type SiteRevisionRecord } from "./site-records";
export { projectForRequest, routeRest } from "./routes";
