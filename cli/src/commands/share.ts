import {
  listShareTokens,
  createShareToken,
  revokeShareToken,
} from "../lib/server-client.js";
import * as cfg from "../lib/config.js";
import { errorMessage, exit } from "../errors";
import type { ApiContext, Auth, ProjectConfig, ShareCreateConfig, ShareProjectConfig, ShareRevokeConfig, ShareTokenRecord } from "../types";

// `scratchwork share <create|list|revoke> ...` - revocable share links.
async function withShareApi(
  serverFlag: string | null | undefined,
  projectArg: string | null | undefined,
  action: (context: ApiContext & { readonly project: string }) => Promise<void>,
): Promise<void> {
  // Project name comes from the positional arg or .scratchwork.json in cwd.
  const projectConfig = cfg.loadProjectConfig(process.cwd()) as ProjectConfig;
  const serverUrl = cfg.resolveServerUrl({ flag: serverFlag, projectConfig });
  const auth = cfg.resolveAuth(serverUrl) as Auth | null;
  const project = projectArg || projectConfig.name;
  if (!project) {
    console.error("scratchwork share: no project (pass a name or run inside a project dir)");
    exit(1);
  }

  try {
    await action({ serverUrl, auth, project });
  } catch (err) {
    console.error(`scratchwork share: ${errorMessage(err)}`);
    exit(1);
  }
}

export async function runShareCreate({ server: serverFlag = null, project = null, name: nameFlag = null, duration = "1w" }: ShareCreateConfig): Promise<void> {
  await withShareApi(serverFlag, project, async ({ serverUrl, auth, project }) => {
    const { share_url } = await createShareToken({ serverUrl, auth, project, name: nameFlag || "share link", duration }) as { readonly share_url: string };
    console.log(`\n  Share link (${duration}):\n\n    ${share_url}\n`);
  });
}

export async function runShareList({ server: serverFlag = null, project = null }: ShareProjectConfig): Promise<void> {
  await withShareApi(serverFlag, project, async ({ serverUrl, auth, project }) => {
    const { share_tokens } = await listShareTokens({ serverUrl, auth, project }) as { readonly share_tokens: ReadonlyArray<ShareTokenRecord> };
    if (!share_tokens.length) return console.log("No share tokens.");
    for (const t of share_tokens) {
      const status = t.is_active ? "active" : t.is_revoked ? "revoked" : "expired";
      console.log(`  ${t.name || "(unnamed)"}  ${t.duration}  ${status}  expires ${t.expires_at}  [id ${t.id}]`);
    }
  });
}

export async function runShareRevoke({ server: serverFlag = null, project = null, id }: ShareRevokeConfig): Promise<void> {
  await withShareApi(serverFlag, project, async ({ serverUrl, auth, project }) => {
    await revokeShareToken({ serverUrl, auth, project, id });
    console.log(`Revoked share token ${id}.`);
  });
}
