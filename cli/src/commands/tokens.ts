import {
  getCurrentUser,
  listTokens,
  createToken,
  revokeToken,
} from "../lib/server-client.js";
import * as cfg from "../lib/config.js";
import { errorMessage, exit } from "../errors";
import type { ApiContext, Auth, ServerConfig, TokenCreateConfig, TokenIdConfig, TokenRecord, TokenUseConfig, User } from "../types";

// `scratchwork tokens <list|create|revoke|use> ...` - API keys for CI.
async function withTokenApi(serverFlag: string | null | undefined, action: (context: ApiContext) => Promise<void>): Promise<void> {
  const serverUrl = cfg.resolveServerUrl({ flag: serverFlag });
  const auth = cfg.resolveAuth(serverUrl) as Auth | null;

  try {
    await action({ serverUrl, auth });
  } catch (err) {
    console.error(`scratchwork tokens: ${errorMessage(err)}`);
    exit(1);
  }
}

export async function runTokenList({ server: serverFlag = null }: ServerConfig): Promise<void> {
  await withTokenApi(serverFlag, async ({ serverUrl, auth }) => {
    const { tokens } = await listTokens({ serverUrl, auth }) as { tokens: ReadonlyArray<TokenRecord> };
    if (!tokens.length) return console.log("No API tokens.");
    for (const t of tokens) {
      console.log(`  ${t.prefix}…  ${t.name || "(unnamed)"}${t.expires_at ? `  expires ${t.expires_at}` : ""}  [id ${t.id}]`);
    }
  });
}

export async function runTokenCreate({ server: serverFlag = null, name, expires: expiresDays = null }: TokenCreateConfig): Promise<void> {
  await withTokenApi(serverFlag, async ({ serverUrl, auth }) => {
    const { token, key } = await createToken({ serverUrl, auth, name, expiresDays: expiresDays || undefined }) as {
      readonly token: string;
      readonly key: { readonly name: string };
    };
    console.log(`\n  Created API token "${key.name}". Copy it now — it won't be shown again:\n`);
    console.log(`    ${token}\n`);
    console.log(`  Use it in CI:  export SCRATCHWORK_TOKEN=${token}\n`);
  });
}

export async function runTokenRevoke({ server: serverFlag = null, id }: TokenIdConfig): Promise<void> {
  await withTokenApi(serverFlag, async ({ serverUrl, auth }) => {
    await revokeToken({ serverUrl, auth, id });
    console.log(`Revoked ${id}.`);
  });
}

export async function runTokenUse({ server: serverFlag = null, token }: TokenUseConfig): Promise<void> {
  await withTokenApi(serverFlag, async ({ serverUrl }) => {
    const useAuth: Auth = { token: token.trim(), type: "api_key" };
    const { user } = await getCurrentUser({ serverUrl, auth: useAuth }) as { user: User };
    cfg.saveCredentials(serverUrl, { token: useAuth.token, type: "api_key", user: { id: user.id, email: user.email, name: user.name } });
    console.log(`Stored API token for ${serverUrl} (${user.email}).`);
  });
}
