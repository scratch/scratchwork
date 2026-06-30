import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type DeployEnv = Record<string, string | undefined>;

interface LoadDeployEnvOptions {
  readonly packageRoot: string;
  readonly argv?: ReadonlyArray<string>;
  readonly processEnv?: DeployEnv;
}

interface LoadedEnvFile {
  readonly path: string;
  readonly values: Record<string, string>;
}

export interface LoadedDeployEnv {
  readonly env: DeployEnv;
  readonly files: ReadonlyArray<string>;
}

/** Loads deploy environment files and overlays shell values with final precedence. */
export async function loadDeployEnv(options: LoadDeployEnvOptions): Promise<LoadedDeployEnv> {
  const processEnv = options.processEnv ?? process.env;
  const packageRoot = resolve(options.packageRoot);
  const serverRoot = dirname(packageRoot);
  const repoRoot = dirname(serverRoot);
  const explicitEnvFile = envFileArg(options.argv ?? []);
  const candidates = [
    join(serverRoot, ".env"),
    join(packageRoot, ".env"),
  ].filter((path): path is string => path != null);

  const loadedFiles: Array<LoadedEnvFile> = [];
  for (const path of candidates) {
    const values = await readEnvFile(path);
    if (values != null) loadedFiles.push({ path, values });
  }

  if (explicitEnvFile != null) {
    const explicit = await readExplicitEnvFile(explicitEnvFile, [process.cwd(), packageRoot, serverRoot, repoRoot]);
    loadedFiles.push(explicit);
  }

  const env: DeployEnv = {};
  for (const file of loadedFiles) {
    Object.assign(env, file.values);
  }
  for (const [key, value] of Object.entries(processEnv)) {
    if (value != null && value !== "") env[key] = value;
  }

  return {
    env,
    files: loadedFiles.map((file) => file.path),
  };
}

/** Copies one defined environment value into a concrete string map. */
export function copyEnv(target: Record<string, string>, env: DeployEnv, key: string): void {
  const value = env[key];
  if (value != null && value !== "") target[key] = value;
}

/** Drops undefined values so the result can be passed to spawned commands. */
export function definedEnv(env: DeployEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value != null) result[key] = value;
  }
  return result;
}

/** Extracts the optional `--env` argument from deploy script argv. */
function envFileArg(argv: ReadonlyArray<string>): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--env") return argv[index + 1];
    if (arg.startsWith("--env=")) return arg.slice("--env=".length);
  }
  return undefined;
}

/** Reads and parses one dotenv file, returning null when it does not exist. */
async function readEnvFile(path: string): Promise<Record<string, string> | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { readonly code?: string }).code === "ENOENT") return null;
    throw error;
  }
  return parseDotenv(text);
}

/** Resolves an explicit env file against allowed roots and requires it to exist. */
async function readExplicitEnvFile(path: string, roots: ReadonlyArray<string>): Promise<LoadedEnvFile> {
  const candidates = isAbsolute(path) ? [path] : roots.map((root) => resolve(root, path));
  for (const candidate of unique(candidates)) {
    const values = await readEnvFile(candidate);
    if (values != null) return { path: candidate, values };
  }
  throw new Error(`Env file not found: ${path}`);
}

/** Preserves first-seen order while removing duplicate candidate paths. */
function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}

/** Parses the small dotenv subset supported by deploy scripts. */
function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const equals = withoutExport.indexOf("=");
    if (equals <= 0) continue;
    const key = withoutExport.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = parseValue(withoutExport.slice(equals + 1).trim());
  }
  return values;
}

/** Unquotes and unescapes one dotenv value. */
function parseValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}
