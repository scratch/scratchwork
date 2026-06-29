import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ObjectStorage, StorageError, safeObjectKey } from "@scratchwork/server-core/storage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface AwsStorageConfig {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
}

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

      return ObjectStorage.of({
        getText: (key) =>
          validateKey(key).pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const response = await client.send(
                    new GetObjectCommand({
                      Bucket: config.bucket,
                      Key: key,
                    }),
                  );
                  return response.Body == null ? null : await response.Body.transformToString("utf-8");
                },
                catch: (cause) =>
                  isS3NotFound(cause)
                    ? new StorageError({ message: "not found", cause })
                    : new StorageError({ message: `Could not read object: ${key}`, cause }),
              }),
            ),
            Effect.catchAll((error) =>
              error.message === "not found" ? Effect.succeed(null) : Effect.fail(error),
            ),
          ),

        putText: (key, value) =>
          validateKey(key).pipe(
            Effect.zipRight(
              Effect.tryPromise({
                try: async () => {
                  await client.send(
                    new PutObjectCommand({
                      Bucket: config.bucket,
                      Key: key,
                      Body: value,
                      ContentType: "application/json; charset=utf-8",
                    }),
                  );
                },
                catch: (cause) =>
                  new StorageError({ message: `Could not write object: ${key}`, cause }),
              }),
            ),
          ),
      });
    }),
  );
}

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

function validateKey(key: string): Effect.Effect<void, StorageError> {
  return safeObjectKey(key)
    ? Effect.void
    : Effect.fail(new StorageError({ message: `Invalid object key: ${key}` }));
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value == null || value === "") return null;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return null;
}

function isS3NotFound(cause: unknown): boolean {
  if (cause instanceof NoSuchKey) return true;
  const candidate = cause as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}
