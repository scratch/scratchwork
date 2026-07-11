import type { ScratchworkServerConfig } from "@scratchwork/server-deploy-cloudflare";

/** Access-protected server settings, shared by the remote and local Cloudflare Worker
 * runs. The Access team domain and application AUD tag are deployment credentials and
 * come from `.env` (SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN / SCRATCHWORK_CF_ACCESS_AUD); the
 * local simulator generates its own. Everything is private: Cloudflare Access blocks
 * anonymous visitors at the edge, so public projects could never be reached anyway. */
export const server = {
  appDomain: "access.sndbx.sh",
  contentDomain: "access-pages.sndbx.sh",
  auth: "cloudflare-access",
  authSessionSeconds: 2_592_000,
  allowedUsers: "public",
  allowPublicProjects: false,
  usersCanSetProjectNames: true,
} satisfies ScratchworkServerConfig;
