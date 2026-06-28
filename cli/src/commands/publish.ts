import { BunContext } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import { existsSync, statSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { buildPublishFiles } from "../lib/publish-build.js";
import { packBundle } from "../../../shared/bundle.js";
import {
  deploy as apiDeploy,
  whoami as apiWhoami,
  ApiError,
} from "../lib/server-client.js";
import * as cfg from "../lib/config.js";
import { openBrowser } from "../browser";
import { errorMessage, exit } from "../errors";
import { loadShell } from "../renderer/default";
import type { Auth, DeployResult, ProjectConfig, PublishBuildResult, PublishConfig, WhoamiResult } from "../types";
import { runLogin } from "./auth";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Print a publish failure and exit. Non-ApiError errors rethrow (a real bug).
function reportDeployError(err: unknown, serverUrl: string, pubRoot: string): never {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      console.error(`\n  Authentication required. Run:\n    scratchwork login --server ${serverUrl}\n`);
    } else if (err.status === 413) {
      console.error(`\n  Deploy too large. Reduce the size of ${pubRoot}.\n`);
    } else {
      console.error(`\n  ${err.message}\n`);
    }
    exit(1);
  }
  throw err;
}

// `scratchwork publish [path] [--server URL] [--name NAME] [--unlisted]
//                      [--no-open] [--dry-run]`
//
// Packages a directory (or a single file, which becomes the site index) into the
// exact static files a host should serve - baking a renderer shell for every
// markdown route - then uploads the gzipped bundle to a Scratchwork server. The
// published site renders byte-for-byte like `scratchwork dev`.
export async function runPublish({
  path: pathArg = ".",
  server: serverFlag = null,
  name: nameFlag = null,
  visibility: visibilityFlag = null,
  unlisted = false,
  private: privateFlag = false,
  noOpen = false,
  dryRun = false,
}: PublishConfig): Promise<void> {
  const visibility = visibilityFlag ?? (privateFlag ? "private" : unlisted ? "unlisted" : null);

  // Resolve the path into a publish root + optional single file (which becomes
  // the index). Mirrors `scratchwork dev` path handling.
  const target = resolve(process.cwd(), pathArg);
  if (!existsSync(target)) {
    console.error(`scratchwork publish: no such file or directory: ${target}`);
    exit(1);
  }
  let pubRoot: string;
  let only: string | null;
  if (statSync(target).isDirectory()) {
    pubRoot = target;
    only = null;
  } else {
    pubRoot = dirname(target);
    only = basename(target);
  }

  const projectConfig = cfg.loadProjectConfig(pubRoot) as ProjectConfig;
  const serverUrl = cfg.resolveServerUrl({ flag: serverFlag, projectConfig });
  const name = (nameFlag || projectConfig.name || basename(pubRoot) || "site").trim();
  let auth = cfg.resolveAuth(serverUrl) as Auth | null;

  const bakedShell = await Effect.runPromise(
    loadShell().pipe(Effect.provide(BunContext.layer)),
  );
  if (bakedShell == null) {
    console.error("scratchwork publish: could not load the renderer shell (renderer build failed)");
    exit(1);
  }

  let built: PublishBuildResult;
  try {
    built = buildPublishFiles({ root: pubRoot, only, bakedShell }) as PublishBuildResult;
  } catch (err) {
    console.error(`scratchwork publish: ${errorMessage(err)}`);
    exit(1);
  }
  if (!built.files.length) {
    console.error("scratchwork publish: nothing to publish (no static files found)");
    exit(1);
  }

  const bundle = await packBundle(built.files);

  console.log(`\n  scratchwork publish`);
  console.log(`  source   ${only ? join(pubRoot, only) : pubRoot}`);
  console.log(`  server   ${serverUrl}`);
  console.log(
    `  files    ${built.stats.fileCount} (${formatBytes(built.stats.totalBytes)} → ${formatBytes(bundle.byteLength)} gzipped)`,
  );

  if (dryRun) {
    console.log(`\n  dry run — not uploading. Bundle contents:`);
    for (const f of built.files) console.log(`    ${f.path}  (${formatBytes(f.data.length)})`);
    console.log("");
    return;
  }

  const doDeploy = () =>
    apiDeploy({ serverUrl, auth, name, id: projectConfig.id, visibility, bundle }) as Promise<DeployResult>;

  let result: DeployResult | undefined;
  try {
    result = await doDeploy();
  } catch (err) {
    // On an accounts server, a 401 means "not logged in" - open the browser to
    // authenticate, then retry once. Skipped when SCRATCHWORK_TOKEN is set (CI:
    // fail rather than prompt) and for legacy token servers (no browser flow).
    let autoLogin = false;
    if (err instanceof ApiError && err.status === 401 && !process.env.SCRATCHWORK_TOKEN) {
      try {
        const info = await apiWhoami({ serverUrl, auth: null }) as WhoamiResult;
        autoLogin = info.mode === "accounts";
      } catch {
        /* leave autoLogin false */
      }
    }
    if (autoLogin) {
      try {
        await runLogin({ server: serverUrl });
      } catch {
        exit(1);
      }
      auth = cfg.resolveAuth(serverUrl) as Auth | null;
      try {
        result = await doDeploy();
      } catch (err2) {
        reportDeployError(err2, serverUrl, pubRoot);
      }
    } else {
      reportDeployError(err, serverUrl, pubRoot);
    }
  }

  if (!result) exit(1);

  // Remember the server-assigned id (+ name/server) so the next publish updates
  // the same project at the same URL.
  cfg.saveProjectConfig(pubRoot, {
    id: result.id,
    name: result.name || name,
    server: serverUrl,
  });

  console.log(`\n  published ${result.created ? "a new project" : `v${result.version}`}`);
  console.log(`  ${result.url}`);
  if (result.byId && result.byId !== result.url) console.log(`  ${result.byId}  (stable URL)`);
  console.log("");

  if (!noOpen) openBrowser(result.url);
}
