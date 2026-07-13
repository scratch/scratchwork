/*
 * Starts (or reuses) the LocalStack container backing the AWS lane. The lane is
 * a required part of `bun run ci`; when Docker is unavailable locally the error
 * says so explicitly, and SCRATCHWORK_E2E_SKIP_AWS=1 is the deliberate, loud
 * opt-out for machines that cannot run it — never silent, and never in CI.
 */

const CONTAINER = "scratchwork-e2e-localstack";
// The community image line: as of 2026 the "stable"/"latest" tags point at the
// licensed distribution and exit without a LOCALSTACK_AUTH_TOKEN; the 4.x
// community line runs S3 + DynamoDB unlicensed, which is all this lane needs.
const IMAGE = "localstack/localstack:4";

/** A reachable LocalStack: its edge endpoint and a stop that only removes the
 * container when this run started it. */
export interface LocalStack {
  readonly endpoint: string;
  readonly stop: () => Promise<void>;
}

/** Returns true when the AWS lane was explicitly skipped (never in CI). */
export function awsLaneSkipped(): boolean {
  if (process.env.SCRATCHWORK_E2E_SKIP_AWS !== "1") return false;
  if (process.env.CI != null && process.env.CI !== "") {
    throw new Error("SCRATCHWORK_E2E_SKIP_AWS is not honored in CI: the AWS lane is a required gate");
  }
  console.warn("⚠️  SCRATCHWORK_E2E_SKIP_AWS=1 — skipping the AWS/LocalStack e2e lane. CI still runs it.");
  return true;
}

/** Ensures a healthy LocalStack container and returns its endpoint. */
export async function ensureLocalStack(): Promise<LocalStack> {
  if (!(await dockerAvailable())) {
    throw new Error(
      "The AWS e2e lane needs Docker for LocalStack, and Docker is not available. " +
      "Start Docker, or skip this lane locally with SCRATCHWORK_E2E_SKIP_AWS=1 (CI always runs it).",
    );
  }

  const running = await docker(["inspect", "-f", "{{.State.Running}}", CONTAINER]);
  let startedHere = false;
  if (running.trim() !== "true") {
    // A stopped leftover container blocks the name; clear it before starting.
    await docker(["rm", "-f", CONTAINER]).catch(() => "");
    await docker([
      "run", "-d",
      "--name", CONTAINER,
      "-e", "SERVICES=s3,dynamodb",
      "-e", "EAGER_SERVICE_LOADING=1",
      "-p", "127.0.0.1::4566",
      IMAGE,
    ], { rejectOnFailure: true });
    startedHere = true;
  }

  const portLine = await docker(["port", CONTAINER, "4566/tcp"], { rejectOnFailure: true });
  const hostPort = portLine.trim().split("\n")[0]?.split(":").pop();
  if (hostPort == null || hostPort === "") throw new Error(`could not read LocalStack port: ${portLine}`);
  const endpoint = `http://127.0.0.1:${hostPort}`;

  await waitForHealth(endpoint);
  return {
    endpoint,
    stop: async () => {
      if (startedHere) await docker(["rm", "-f", CONTAINER]).catch(() => "");
    },
  };
}

/** Polls LocalStack's health endpoint until s3 and dynamodb are serving. */
async function waitForHealth(endpoint: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/_localstack/health`);
      const body = await response.json() as { readonly services?: Record<string, string> };
      const services = body.services ?? {};
      const ready = ["s3", "dynamodb"].every((name) => ["running", "available"].includes(services[name] ?? ""));
      if (ready) return;
      lastError = JSON.stringify(services);
    } catch (error) {
      lastError = (error as Error).message;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`LocalStack did not become healthy within ${timeoutMs / 1000}s: ${lastError}`);
}

/** Returns true when the docker daemon answers. */
async function dockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info", "--format", "{{.ServerVersion}}"], { stdout: "pipe", stderr: "pipe" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Runs one docker command and returns stdout; empty string on failure by default. */
async function docker(args: ReadonlyArray<string>, options: { readonly rejectOnFailure?: boolean } = {}): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    if (options.rejectOnFailure) throw new Error(`docker ${args.join(" ")} failed: ${stderr.trim()}`);
    return "";
  }
  return stdout;
}
