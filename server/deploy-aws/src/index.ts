export {
  deployServer,
  type AwsDeployConfig,
  type AwsDeployOptions,
  type AwsDeployResult,
  type AwsDeployServerConfig,
  type ScratchworkServerConfig,
} from "./deploy.ts";
export { DynamoDbPrimitiveDbLive, makeDynamoDbPrimitiveDb, readDynamoDbPrimitiveDbConfig, type DynamoDbPrimitiveDbConfig } from "./dynamodb-db.ts";
export { S3ObjectStorageLive } from "./s3-storage.ts";
