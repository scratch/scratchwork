import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ObjectStorage, StorageConflict, StorageError, requireSafeObjectKey, type ObjectStorageShape } from "@scratchwork/server-core/storage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface AwsStorageConfig {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
}

/** Adapts S3 to the server object storage contract. */
export function AwsObjectStorageLive(
  env: Readonly<Record<string, string | undefined>>,
): Layer.Layer<ObjectStorage, StorageError> {
  return Layer.effect(
    ObjectStorage,
    Effect.gen(function* () {
      const config = yield* readAwsStorageConfig(env);
      const client = new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
      });

      const getObject: ObjectStorageShape["getObject"] = (key) =>
        requireSafeObjectKey(key).pipe(
          Effect.zipRight(
            Effect.tryPromise({
              try: async () => {
                try {
                const response = await client.send(
                  new GetObjectCommand({
                    Bucket: config.bucket,
                    Key: key,
                  }),
                );
                return response.Body == null
                  ? null
                  : {
                      key,
                      body: await response.Body.transformToByteArray(),
                      contentType: response.ContentType,
                      etag: response.ETag,
                    };
                } catch (cause) {
                  if (isS3NotFound(cause)) return null;
                  throw cause;
                }
              },
              catch: (cause) =>
                new StorageError({ message: `Could not read object: ${key}`, cause }),
            }),
          ),
        );

      const putObject: ObjectStorageShape["putObject"] = (key, value, options) =>
        requireSafeObjectKey(key).pipe(
          Effect.zipRight(
            Effect.tryPromise({
              try: async () => {
                const response = await client.send(
                  new PutObjectCommand({
                    Bucket: config.bucket,
                    Key: key,
                    Body: value,
                    CacheControl: options?.cacheControl,
                    ContentType: options?.contentType,
                    IfMatch: options?.ifMatch,
                    IfNoneMatch: options?.ifNoneMatch,
                  }),
                );
                return { etag: response.ETag };
              },
              catch: (cause) =>
                isS3Conflict(cause)
                  ? new StorageConflict({ key, message: `Object write precondition failed: ${key}` })
                  : new StorageError({ message: `Could not write object: ${key}`, cause }),
            }),
          ),
        );

      return ObjectStorage.of({
        getObject,
        putObject,
        getText: (key) =>
          getObject(key).pipe(Effect.map((object) => object == null ? null : new TextDecoder().decode(object.body))),
        putText: (key, value, options) => putObject(key, new TextEncoder().encode(value), options),
      });
    }),
  );
}

/** Reads S3 bucket and client settings from deployment environment values. */
function readAwsStorageConfig(
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<AwsStorageConfig, StorageError> {
  const bucket = env.SCRATCHWORK_S3_BUCKET;
  if (!bucket) {
    return Effect.fail(
      new StorageError({ message: "SCRATCHWORK_S3_BUCKET is required for AWS storage" }),
    );
  }

  const endpoint = env.SCRATCHWORK_S3_ENDPOINT;
  return Effect.succeed({
    bucket,
    region: env.SCRATCHWORK_S3_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1",
    endpoint,
    forcePathStyle: parseBoolean(env.SCRATCHWORK_S3_FORCE_PATH_STYLE) ?? endpoint != null,
  });
}

/** Parses common env-style boolean strings. */
function parseBoolean(value: string | undefined): boolean | null {
  if (value == null || value === "") return null;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return null;
}

/** Detects S3 not-found errors across SDK exception shapes. */
function isS3NotFound(cause: unknown): boolean {
  if (cause instanceof NoSuchKey) return true;
  const candidate = cause as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}

/** Detects S3 conditional write failures. */
function isS3Conflict(cause: unknown): boolean {
  const candidate = cause as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 409 || candidate.$metadata?.httpStatusCode === 412;
}
