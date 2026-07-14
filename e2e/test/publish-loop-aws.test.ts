/*
 * Full publish loop against the real AWS Lambda handler with the S3/DynamoDB
 * adapters pointed at LocalStack. Docker is required; this lane is part of the
 * required gate, and SCRATCHWORK_E2E_SKIP_AWS=1 is the loud local-only opt-out.
 */
import { awsLaneSkipped, ensureLocalStack } from "../src/localstack";
import { publishLoopSuite } from "../src/suite";

if (!awsLaneSkipped()) {
  publishLoopSuite("aws", {
    setup: async () => {
      const localstack = await ensureLocalStack();
      return {
        extraEnv: { SCRATCHWORK_E2E_LOCALSTACK: localstack.endpoint },
        teardown: localstack.stop,
      };
    },
  });
}
