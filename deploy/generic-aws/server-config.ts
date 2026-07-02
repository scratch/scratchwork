import type { ScratchworkServerConfig } from "@scratchwork/server-deploy-aws";

/**
 * Generic AWS server settings, shared by the AWS deploy and the local run. This
 * project is a placeholder — it deploys a domainless Lambda Function URL server
 * and exists in case we want to spend more time developing our AWS deploy
 * capabilities. Settings not listed here come from environment variables
 * (SCRATCHWORK_*); see server/README.md.
 */
export const server = {
  auth: "oauth",
} satisfies ScratchworkServerConfig;
