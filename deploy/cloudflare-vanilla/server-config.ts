import type { ScratchworkServerConfig } from "@scratchwork/server-deploy-cloudflare";

/** sndbx.sh server settings, shared by the remote and local Cloudflare Worker runs. */
export const server = {
  appDomain: "app.sndbx.sh",
  contentDomain: "pages.sndbx.sh",
  homepageDomains: ["sndbx.sh", "www.sndbx.sh"],
  homepageProject: "www",
  auth: "oauth",
  authSessionSeconds: 2_592_000,
  allowedUsers: "public",
  allowPublicProjects: true,
  usersCanSetProjectNames: true,
} satisfies ScratchworkServerConfig;
