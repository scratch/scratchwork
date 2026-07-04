import type { ScratchworkServerConfig } from "@scratchwork/server-deploy-cloudflare";

/** sndbx.sh server settings, shared by the Cloudflare deploy and the local run. */
export const server = {
  appDomain: "app.sndbx.sh",
  contentDomain: "pages.sndbx.sh",
  auth: "oauth",
  authSessionSeconds: 2_592_000,
  allowedUsers: "public",
  maxVisibility: "public",
  projectRoutingMode: "workspace/project",
  defaultWorkspace: "username",
  defaultVisibility: "private",
} satisfies ScratchworkServerConfig;
