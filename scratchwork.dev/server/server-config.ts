import type { ScratchworkServerConfig } from "@scratchwork/server-deploy-cloudflare";

/** scratchwork.dev server settings, shared by the remote and local Cloudflare Worker runs. */
export const server = {
  appDomain: "app.scratchwork.dev",
  contentDomain: "pages.scratchwork.dev",
  homepageDomains: ["scratchwork.dev", "www.scratchwork.dev"],
  homepageProject: "www",
  auth: "oauth",
  authSessionSeconds: 2_592_000,
  allowedUsers: "public",
  allowPublicProjects: true,
  usersCanSetProjectNames: true,
} satisfies ScratchworkServerConfig;
