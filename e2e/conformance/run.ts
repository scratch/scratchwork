#!/usr/bin/env bun
/*
 * OIDC relying-party conformance lane (spiked in notes/oidc-conformance-spike.md):
 * runs the OpenID Foundation conformance suite locally in Docker as an adversarial
 * provider and drives Scratchwork's real login flow through every module of the
 * basic RP certification plan (oidcc-client-basic-certification-test-plan).
 *
 * On-demand: `bun run conformance` in e2e/. Requires Docker. Not part of `bun test`
 * or `bun run ci` yet — the gate plan wires it in once the plan is green and timed.
 *
 * Shape (mirrors the suite's own scripts/run-test-plan.py):
 *   1. `docker compose up` the pinned suite; wait for GET /api/runner/available.
 *   2. POST /api/plan with the static-client config; iterate its modules.
 *   3. Per module: fresh local-dev Scratchwork (restarted to clear the JWKS cache)
 *      pointed at the suite through a loopback HTTP proxy, create the runner, wait
 *      for WAITING, drive GET /auth/login with the harness Browser, then wait for
 *      FINISHED/INTERRUPTED and record the verdict.
 *   4. Exit nonzero unless every required module is PASSED or WARNING.
 *
 * Scope (decided 2026-07-20, recorded in the spike note): the lane runs exactly
 * the seven modules judged by the RP *rejecting* a tampered ID token. The rest of
 * the plan requires completing a login against the suite's OP — a userinfo call
 * and email sourced outside the ID token — which Scratchwork deliberately does
 * not do (single-provider RP; the ID token is the only credential it consumes).
 * Those modules are not-applicable-by-design, not aspirational.
 *
 * The loopback proxy exists because the SCRATCHWORK_LOCAL_OAUTH_* overrides —
 * deliberately — accept only literal-loopback plain-HTTP endpoints, while the
 * suite serves HTTPS under localhost.emobix.co.uk (public DNS for 127.0.0.1) with
 * a self-signed certificate. The proxy terminates the loopback side and forwards
 * to the suite with TLS verification disabled — acceptable for test
 * infrastructure talking to a local container, never for product code.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, nextPort, startBackend } from "../src/harness";

const conformanceDir = dirname(fileURLToPath(import.meta.url));

const SUITE_BASE = (process.env.CONFORMANCE_SUITE_URL ?? "https://localhost.emobix.co.uk:8443").replace(/\/$/, "");
const PLAN_NAME = "oidcc-client-basic-certification-test-plan";
const PLAN_VARIANT = { client_registration: "static_client", request_type: "plain_http_request" };
const ALIAS = "scratchwork";
const CLIENT_ID = "scratchwork-conformance-client";
const CLIENT_SECRET = "scratchwork-conformance-secret";
const SESSION_SECRET = "scratchwork-conformance-session-secret-32b";
/** How long the suite waits for RP silence before passing a negative test. */
const WAIT_TIMEOUT_SECONDS = 5;
/** Client-side cap per module before declaring it stuck and aborting it. */
const MODULE_CAP_MS = 60_000;
/** The required assertion set: every module the plan judges by the RP rejecting a
 * tampered ID token. The plan's other modules only finish after a completed login
 * (userinfo call, email outside the ID token) and are N/A by design — see the
 * scope note in the header. A plan module missing from this set is skipped and
 * logged; a set entry missing from the plan fails the run (renamed upstream). */
const REQUIRED_MODULES: ReadonlyArray<string> = [
  "oidcc-client-test-invalid-iss",
  "oidcc-client-test-missing-sub",
  "oidcc-client-test-invalid-aud",
  "oidcc-client-test-missing-iat",
  "oidcc-client-test-kid-absent-multiple-jwks",
  "oidcc-client-test-invalid-sig-rs256",
  "oidcc-client-test-nonce-invalid",
];

/** Fetches a suite URL: connects to 127.0.0.1 for the suite's public-DNS loopback
 * hostname (so runs survive DNS-rebind-protective resolvers) and skips TLS
 * verification for its self-signed certificate. */
function suiteFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url);
  const connectUrl = new URL(target);
  if (target.hostname === "localhost.emobix.co.uk") connectUrl.hostname = "127.0.0.1";
  return fetch(connectUrl.toString(), {
    redirect: "manual",
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), host: target.host },
    tls: { rejectUnauthorized: false },
  } as RequestInit);
}

// ---------------------------------------------------------------------------
// Suite REST API (devmode: no bearer token needed)
// ---------------------------------------------------------------------------

interface PlanInstance {
  readonly id: string;
  readonly modules: ReadonlyArray<{ readonly testModule: string }>;
}

async function createPlan(): Promise<PlanInstance> {
  const query = new URLSearchParams({ planName: PLAN_NAME, variant: JSON.stringify(PLAN_VARIANT) });
  const config = {
    alias: ALIAS,
    description: "Scratchwork RP conformance lane",
    waitTimeoutSeconds: WAIT_TIMEOUT_SECONDS,
    client: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: redirectUri },
  };
  const response = await suiteFetch(`${SUITE_BASE}/api/plan?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });
  if (response.status !== 201) throw new Error(`create plan failed: HTTP ${response.status} ${await response.text()}`);
  return await response.json() as PlanInstance;
}

async function createRunner(testModule: string, planId: string): Promise<string> {
  const query = new URLSearchParams({ test: testModule, plan: planId });
  const response = await suiteFetch(`${SUITE_BASE}/api/runner?${query}`, { method: "POST" });
  if (response.status !== 201) throw new Error(`create runner failed: HTTP ${response.status} ${await response.text()}`);
  const created = await response.json() as { readonly id: string };
  return created.id;
}

interface ModuleInfo {
  readonly status: string;
  readonly result?: string;
}

async function moduleInfo(moduleId: string): Promise<ModuleInfo> {
  const response = await suiteFetch(`${SUITE_BASE}/api/info/${moduleId}`);
  if (response.status !== 200) throw new Error(`module info failed: HTTP ${response.status}`);
  return await response.json() as ModuleInfo;
}

/** Long-polls the module until its status is one of `states`; false on `capMs`. */
async function waitForState(moduleId: string, states: ReadonlyArray<string>, capMs: number): Promise<boolean> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    const timeoutMs = Math.min(15_000, deadline - Date.now());
    const query = new URLSearchParams({ states: states.join(","), timeoutMs: String(timeoutMs) });
    const response = await suiteFetch(`${SUITE_BASE}/api/runner/${moduleId}/wait-state?${query}`);
    if (response.status !== 200) throw new Error(`wait-state failed: HTTP ${response.status} ${await response.text()}`);
    const body = await response.json() as { readonly state?: string; readonly timeout?: boolean };
    if (body.state != null && states.includes(body.state)) return true;
  }
  return false;
}

async function abortModule(moduleId: string): Promise<void> {
  await suiteFetch(`${SUITE_BASE}/api/runner/${moduleId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Suite lifecycle
// ---------------------------------------------------------------------------

async function suiteHealthy(): Promise<boolean> {
  try {
    const response = await suiteFetch(`${SUITE_BASE}/api/runner/available`);
    return response.status === 200;
  } catch {
    return false;
  }
}

function compose(args: ReadonlyArray<string>): Promise<number> {
  const proc = Bun.spawn(["docker", "compose", "-f", join(conformanceDir, "docker-compose.yml"), "-p", "scratchwork-oidc-conformance", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

async function waitForSuite(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await suiteHealthy()) return;
    await Bun.sleep(3_000);
  }
  throw new Error(`conformance suite did not become healthy at ${SUITE_BASE} within ${timeoutMs / 1000}s`);
}

// ---------------------------------------------------------------------------
// Loopback proxy: plain-HTTP 127.0.0.1 front for the suite's per-alias endpoints
// ---------------------------------------------------------------------------

function startProxy(issuer: string): { readonly env: Record<string, string>; stop(): void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const target = new URL(issuer);
      target.pathname = `${target.pathname}${url.pathname.slice(1)}`;
      target.search = url.search;
      const forwardHeaders: Record<string, string> = {};
      for (const name of ["content-type", "authorization", "accept"]) {
        const value = request.headers.get(name);
        if (value != null) forwardHeaders[name] = value;
      }
      const upstream = await suiteFetch(target.toString(), {
        method: request.method,
        headers: forwardHeaders,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      });
      const headers = new Headers();
      for (const name of ["location", "content-type", "www-authenticate", "cache-control"]) {
        const value = upstream.headers.get(name);
        if (value != null) headers.set(name, value);
      }
      return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    env: {
      SCRATCHWORK_LOCAL_OAUTH_AUTHORIZE_URL: `${base}/authorize`,
      SCRATCHWORK_LOCAL_OAUTH_TOKEN_URL: `${base}/token`,
      SCRATCHWORK_LOCAL_OAUTH_JWKS_URL: `${base}/jwks`,
      SCRATCHWORK_LOCAL_OAUTH_ISSUER: issuer,
    },
    stop() {
      server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** One fixed RP port across all modules: the redirect URI is registered once in
 * the plan's static client configuration. */
const rpPort = nextPort();
const redirectUri = `http://localhost:${rpPort}/auth/callback/google`;
const issuer = `${SUITE_BASE}/test/a/${ALIAS}/`;

interface ModuleOutcome {
  readonly module: string;
  readonly status: string;
  readonly result: string;
  readonly note?: string;
}

const startedSuite = !(await suiteHealthy());
if (startedSuite) {
  console.log("starting the conformance suite (first run pulls ~2GB of images)…");
  if ((await compose(["up", "-d", "--quiet-pull"])) !== 0) {
    console.error("docker compose up failed — is Docker running?");
    process.exit(1);
  }
}
await waitForSuite(300_000);
console.log(`suite ready at ${SUITE_BASE}`);

const proxy = startProxy(issuer);
const outcomes: ModuleOutcome[] = [];
try {
  const plan = await createPlan();
  const planModules = plan.modules.map((entry) => entry.testModule);
  const missing = REQUIRED_MODULES.filter((name) => !planModules.includes(name));
  if (missing.length > 0) {
    throw new Error(`required modules missing from the plan (renamed upstream?): ${missing.join(", ")}`);
  }
  const skipped = planModules.filter((name) => !REQUIRED_MODULES.includes(name));
  console.log(`plan ${plan.id}: running ${REQUIRED_MODULES.length} of ${planModules.length} modules (issuer ${issuer})`);
  console.log(`skipped as N/A by design: ${skipped.join(", ")}`);

  for (const testModule of REQUIRED_MODULES) {
    const backend = await startBackend("local-dev", {
      port: rpPort,
      providerEnv: proxy.env,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      sessionSecret: SESSION_SECRET,
    });
    let note: string | undefined;
    const moduleId = await createRunner(testModule, plan.id);
    try {
      await waitForState(moduleId, ["WAITING", "FINISHED", "INTERRUPTED"], 30_000);
      // Drive the RP. The suite is the judge: a failed login here is a correct
      // outcome for the tampering modules, so failures are recorded, not fatal.
      await new Browser().get(`${backend.appUrl}/auth/login?returnTo=/`, { maxHops: 15 })
        .catch((error: unknown) => {
          note = `login drive error: ${error instanceof Error ? error.message : String(error)}`;
        });
      const finished = await waitForState(moduleId, ["FINISHED", "INTERRUPTED"], MODULE_CAP_MS);
      if (!finished) {
        note = `stuck ${(await moduleInfo(moduleId)).status} after ${MODULE_CAP_MS / 1000}s — aborted (RP never made the calls the module waits for)`;
        await abortModule(moduleId);
      }
      const info = await moduleInfo(moduleId);
      outcomes.push({ module: testModule, status: info.status, result: info.result ?? "UNKNOWN", note });
      console.log(`${testModule}: ${info.result ?? "UNKNOWN"}${note == null ? "" : ` (${note})`}`);
    } finally {
      await backend.stop();
    }
  }
} finally {
  proxy.stop();
  if (startedSuite && process.env.CONFORMANCE_KEEP_SUITE == null) await compose(["down"]);
}

const failed = outcomes.filter((outcome) => outcome.result !== "PASSED" && outcome.result !== "WARNING");
console.log(`\n${"module".padEnd(48)} result`);
for (const outcome of outcomes) {
  console.log(`${outcome.module.padEnd(48)} ${outcome.result}${outcome.note == null ? "" : `  [${outcome.note}]`}`);
}
console.log(`\n${outcomes.length - failed.length}/${outcomes.length} required modules passed (PASSED or WARNING).`);
if (failed.length > 0) {
  console.error(`failed: ${failed.map((outcome) => outcome.module).join(", ")}`);
  console.error(`inspect logs in the suite UI: ${SUITE_BASE}/plan-detail.html (or /api/log/{moduleId})`);
  process.exit(1);
}
