/*
 * Shared harness for the full-loop e2e: disjoint ports per test file, a minimal
 * "browser" (cookie jar + manual redirect following, with *.localhost hosts
 * mapped to 127.0.0.1 since macOS does not resolve localhost subdomains), the
 * real-CLI runner, and the backend subprocess launcher.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

/** Disjoint port ranges per test file, mirroring cli/test/e2e-helpers.js. */
let portCounter = Number(process.env.SCRATCHWORK_E2E_PORT_BASE ?? 35100);
export const nextPort = (): number => portCounter++;

/** The command that runs the real CLI: the prebuilt test bundle when the runner
 * provides one, the TypeScript entry otherwise. */
export const CLI: ReadonlyArray<string> = process.env.SCRATCHWORK_E2E_CLI != null && process.env.SCRATCHWORK_E2E_CLI !== ""
  ? ["bun", process.env.SCRATCHWORK_E2E_CLI]
  : ["bun", join(repoRoot, "cli", "src", "index.ts")];

/** A finished CLI run. */
export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI to completion with browser-opening disabled. */
export async function runCli(
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const proc = Bun.spawn([...CLI, ...args], {
    cwd,
    env: { ...process.env, SCRATCHWORK_NO_OPEN: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Spawns a long-running CLI command (login, stream) without waiting for exit. */
export function spawnCli(
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string | undefined> = {},
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([...CLI, ...args], {
    cwd,
    env: { ...process.env, SCRATCHWORK_NO_OPEN: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Reads a process's stdout until it contains `text`; kills and fails on timeout. */
export async function readOutputUntil(
  proc: { stdout: ReadableStream<Uint8Array>; kill: () => void },
  text: string,
  timeoutMs = 15_000,
): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!output.includes(text)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        proc.kill();
        throw new Error(`timed out waiting for ${JSON.stringify(text)}; output so far:\n${output}`);
      }
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("read timeout")), remaining)),
      ]).catch((error) => {
        proc.kill();
        throw new Error(`${(error as Error).message}; output so far:\n${output}`);
      });
      if (chunk.done) throw new Error(`process exited before ${JSON.stringify(text)}; output:\n${output}`);
      output += decoder.decode(chunk.value, { stream: true });
    }
    return output;
  } finally {
    reader.releaseLock();
  }
}

/** Creates a temp directory removed by `cleanup`. */
export function tempDir(prefix: string): { readonly path: string; readonly remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

interface StoredCookie {
  readonly value: string;
  readonly path: string;
}

/** One observed hop of a browser navigation. */
export interface BrowserHop {
  readonly url: string;
  readonly status: number;
  readonly location: string | null;
}

/** The final state of a browser navigation. */
export interface BrowserResult {
  readonly status: number;
  readonly url: string;
  readonly response: Response;
  readonly hops: ReadonlyArray<BrowserHop>;
}

/**
 * A minimal browser: per-host cookie jar (path-scoped), manual redirect
 * following so tests can observe and tamper with every hop, and loopback
 * mapping for hostnames macOS cannot resolve. It deliberately mimics the
 * pieces of browser behavior the auth flows depend on; it is not a fidelity
 * tool.
 */
export class Browser {
  private readonly jar = new Map<string, Map<string, StoredCookie>>();

  /** GETs a URL, following redirects (cross-host included) up to `maxHops`. */
  async get(url: string, options: { readonly maxHops?: number; readonly stopWhen?: (next: string) => boolean } = {}): Promise<BrowserResult> {
    const hops: BrowserHop[] = [];
    let current = url;
    const maxHops = options.maxHops ?? 10;
    for (let hop = 0; hop <= maxHops; hop++) {
      const response = await this.request(current);
      const location = response.headers.get("location");
      const target = location == null ? null : new URL(location, current).toString();
      hops.push({ url: current, status: response.status, location: target });
      if (response.status < 300 || response.status >= 400 || target == null) {
        return { status: response.status, url: current, response, hops };
      }
      if (options.stopWhen?.(target)) {
        return { status: response.status, url: current, response, hops };
      }
      current = target;
    }
    throw new Error(`redirect loop: ${hops.map((h) => `${h.status} ${h.url}`).join(" -> ")}`);
  }

  /** Issues one request with this browser's cookies, without following redirects. */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url);
    const cookie = this.cookieHeader(target);
    const connectUrl = new URL(target);
    const mapped = mapLoopbackHost(target.hostname);
    if (mapped != null) connectUrl.hostname = mapped;
    const response = await fetch(connectUrl.toString(), {
      ...init,
      redirect: "manual",
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        host: target.host,
        ...(cookie === "" ? {} : { cookie }),
      },
    });
    this.storeCookies(target, response);
    return response;
  }

  /** Returns the cookie header this browser would send to a URL. */
  cookieHeader(target: URL): string {
    const cookies = this.jar.get(target.hostname);
    if (cookies == null) return "";
    return [...cookies.entries()]
      .filter(([, stored]) => target.pathname === stored.path || target.pathname.startsWith(stored.path.endsWith("/") ? stored.path : `${stored.path}/`) || stored.path === "/")
      .map(([name, stored]) => `${name}=${stored.value}`)
      .join("; ");
  }

  /** Injects a cookie, as an attacker-controlled or cross-host test would. */
  setCookie(hostname: string, name: string, value: string, path = "/"): void {
    const cookies = this.jar.get(hostname) ?? new Map<string, StoredCookie>();
    cookies.set(name, { value, path });
    this.jar.set(hostname, cookies);
  }

  /** Reads one stored cookie value. */
  getCookie(hostname: string, name: string): string | undefined {
    return this.jar.get(hostname)?.get(name)?.value;
  }

  /** Lists stored cookie names for a host. */
  cookieNames(hostname: string): ReadonlyArray<string> {
    return [...(this.jar.get(hostname)?.keys() ?? [])];
  }

  private storeCookies(target: URL, response: Response): void {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) return;
    const cookies = this.jar.get(target.hostname) ?? new Map<string, StoredCookie>();
    for (const header of setCookies) {
      const [pair, ...attributes] = header.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const pathAttr = attributes.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith("path="));
      const path = pathAttr == null ? "/" : pathAttr.slice(5);
      const maxAgeAttr = attributes.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith("max-age="));
      if (maxAgeAttr != null && Number(maxAgeAttr.slice(8)) <= 0) {
        cookies.delete(name);
      } else {
        cookies.set(name, { value, path });
      }
    }
    this.jar.set(target.hostname, cookies);
  }
}

/** Maps unresolvable loopback hostnames (*.localhost) to 127.0.0.1. */
function mapLoopbackHost(hostname: string): string | null {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return "127.0.0.1";
  return null;
}

/** Fetches a URL once with loopback host mapping and no cookies. */
export async function rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url);
  const connectUrl = new URL(target);
  const mapped = mapLoopbackHost(target.hostname);
  if (mapped != null) connectUrl.hostname = mapped;
  return fetch(connectUrl.toString(), {
    redirect: "manual",
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), host: target.host },
  });
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/** A running backend under test. */
export interface Backend {
  readonly appUrl: string;
  readonly contentUrl: string;
  readonly stop: () => Promise<void>;
  readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
}

/** The three server deployments the suite runs against. */
export type BackendLane = "local-dev" | "cloudflare" | "aws";

/** Environment shared by every backend lane. */
export interface BackendEnv {
  readonly port: number;
  readonly providerEnv: Record<string, string>;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly sessionSecret: string;
  readonly extraEnv?: Record<string, string>;
}

const laneScripts: Record<BackendLane, string> = {
  "local-dev": join(repoRoot, "deploy", "local-dev", "local.ts"),
  cloudflare: join(import.meta.dir, "servers", "cloudflare.ts"),
  aws: join(import.meta.dir, "servers", "aws.ts"),
};

/**
 * Spawns one backend as a subprocess — the local-dev lane runs the actual
 * deploy/local-dev entrypoint — and waits for its ready banner. Every lane
 * serves both hosts on one port: the app on localhost, published content on
 * pages.localhost.
 */
export async function startBackend(lane: BackendLane, env: BackendEnv): Promise<Backend> {
  const appUrl = `http://localhost:${env.port}`;
  const contentUrl = `http://pages.localhost:${env.port}`;
  const storage = tempDir(`scratchwork-e2e-${lane}-storage-`);
  const proc = Bun.spawn(["bun", laneScripts[lane]], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(env.port),
      SCRATCHWORK_APP_URL: appUrl,
      SCRATCHWORK_CONTENT_URL: contentUrl,
      SCRATCHWORK_AUTH: "oauth",
      SCRATCHWORK_GOOGLE_CLIENT_ID: env.clientId,
      SCRATCHWORK_GOOGLE_CLIENT_SECRET: env.clientSecret,
      SCRATCHWORK_SESSION_SECRET: env.sessionSecret,
      SCRATCHWORK_STORAGE_DIR: storage.path,
      ...env.providerEnv,
      ...env.extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await readOutputUntil(proc, `app      ${appUrl}`, 90_000);
  } catch (error) {
    const stderr = await new Response(proc.stderr).text().catch(() => "");
    storage.remove();
    throw new Error(`${lane} backend failed to start: ${(error as Error).message}\nstderr:\n${stderr}`);
  }

  return {
    appUrl,
    contentUrl,
    proc,
    stop: async () => {
      proc.kill();
      await proc.exited;
      storage.remove();
    },
  };
}
