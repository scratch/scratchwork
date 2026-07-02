import {
  deployServer,
  type AwsDeployServerConfig,
} from "@scratchwork/server-deploy-aws";
import { server } from "./server-config";

const config = {
  server,

  // No fixed deploy names: region, function name, role name, bucket, and table
  // fall back to SCRATCHWORK_AWS_* environment variables or adapter defaults.
  deploy: {},
} satisfies AwsDeployServerConfig;

const result = await deployServer(config, { envFile: ".env" });

console.log(`scratchwork AWS server deployed: ${result.url}`);
console.log(`publish with: scratchwork publish --server ${result.url}`);
