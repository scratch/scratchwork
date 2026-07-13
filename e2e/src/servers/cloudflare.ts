/*
 * Cloudflare backend lane: bundles the production Worker (the same `bun build`
 * the deploy pipeline runs) and serves it under miniflare/workerd with real R2
 * and D1 bindings, so the e2e exercises the actual worker entrypoint and the
 * R2/D1 adapters rather than in-process stubs.
 *
 * Spawned by the harness with the same SCRATCHWORK_* environment as every lane;
 * prints the shared `app      <url>` ready banner.
 */
import { Miniflare } from "miniflare";
import { DEFAULT_CLOUDFLARE_COMPATIBILITY_DATE } from "@scratchwork/server-deploy-cloudflare";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const workerEntry = join(repoRoot, "server", "deploy-cloudflare", "src", "worker.ts");

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error("cloudflare lane requires PORT");
  process.exit(1);
}

// workerd cannot follow the macOS temp dir's /var symlink out of its root, so
// the bundle lives under the (gitignored) test build dir; one file per port
// keeps parallel lanes from clobbering each other.
const outdir = join(repoRoot, "e2e", "test", ".build", `worker-${port}`);
mkdirSync(outdir, { recursive: true });
const build = await Bun.build({
  entrypoints: [workerEntry],
  target: "browser",
  format: "esm",
  outdir,
  naming: "worker.js",
});
if (!build.success) {
  console.error("worker build failed:", build.logs.map((log) => log.message).join("\n"));
  process.exit(1);
}

/** String config vars forwarded into the worker as plain bindings. */
const bindings: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value != null && (key === "PORT" || key.startsWith("SCRATCHWORK_") || key.startsWith("GOOGLE_"))) {
    bindings[key] = value;
  }
}

const mf = new Miniflare({
  modules: true,
  scriptPath: join(outdir, "worker.js"),
  compatibilityDate: DEFAULT_CLOUDFLARE_COMPATIBILITY_DATE,
  host: "127.0.0.1",
  port,
  r2Buckets: ["SCRATCHWORK_R2"],
  d1Databases: { SCRATCHWORK_D1: "scratchwork-e2e" },
  bindings,
});

await mf.ready;
console.log("scratchwork e2e cloudflare (miniflare)");
console.log(`app      ${process.env.SCRATCHWORK_APP_URL}`);
console.log(`content  ${process.env.SCRATCHWORK_CONTENT_URL}`);

const shutdown = async () => {
  await mf.dispose();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
