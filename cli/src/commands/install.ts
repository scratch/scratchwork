/*
 * `scratchwork install` / `scratchwork update` - self-installation and
 * self-update for the compiled release binary.
 *
 * install copies the running binary into an install directory, verifies it
 * runs, and prints PATH advice. It is the tail of the curl|bash flow:
 * scratchwork.dev/www/install.sh downloads, checksum-verifies, and extracts a
 * release, then delegates everything after that to `scratchwork install`.
 *
 * update downloads the latest release (or SCRATCHWORK_VERSION) for this
 * platform from GitHub Releases, verifies its checksum, unpacks it beside the
 * running binary, confirms the new binary runs, and only then atomically
 * replaces the running binary in place - so a bad download never displaces a
 * working install.
 *
 * Both refuse to run from source (`bun src/index.ts`): they operate on the
 * running executable, which for a source run would be Bun itself.
 */
import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import * as HttpClient from "@effect/platform/HttpClient";
import * as Path from "@effect/platform/Path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { sha256Hex } from "@scratchwork/shared/crypto/digest";
import pkg from "../../package.json";
import { CliError, errorMessage } from "../errors";

/** Release download base; SCRATCHWORK_DOWNLOAD_BASE overrides it (hermetic ci fixture). */
const DOWNLOAD_BASE = "https://github.com/scratch/scratchwork/releases";

/** An environment variable, with unset and empty treated alike - the same as sh's `${VAR:-default}` in install.sh. */
const env = (name: string): string | undefined => process.env[name] || undefined;

const downloadBase = () => env("SCRATCHWORK_DOWNLOAD_BASE") ?? DOWNLOAD_BASE;

type SelfCommand = "install" | "update";

const fail = (command: SelfCommand, message: string) =>
  new CliError({ code: 1, message: `scratchwork ${command}: ${message}` });

/** Rewraps non-CliError failures (platform errors) as a CliError with the given context. */
const failWith = (command: SelfCommand, context: string) => (cause: unknown) =>
  cause instanceof CliError ? cause : fail(command, `${context}: ${errorMessage(cause)}`);

/** The running compiled binary's path. Fails for source runs, where the executable is Bun. */
function selfBinary(command: SelfCommand): Effect.Effect<string, CliError> {
  return Bun.main.startsWith("/$bunfs/")
    ? Effect.succeed(process.execPath)
    : Effect.fail(
        fail(
          command,
          "not running from a compiled release binary. Install one with: curl -fsSL https://scratchwork.dev/install.sh | bash",
        ),
      );
}

/** Maps the running process to a release asset target such as darwin-arm64. */
function releaseTarget(command: SelfCommand): Effect.Effect<string, CliError> {
  const os = process.platform === "darwin" || process.platform === "linux" ? process.platform : null;
  const arch = process.arch === "arm64" || process.arch === "x64" ? process.arch : null;
  return os == null || arch == null
    ? Effect.fail(
        fail(
          command,
          `no prebuilt binaries for ${process.platform}-${process.arch}. Prebuilt binaries cover macOS and glibc Linux on arm64 and x64.`,
        ),
      )
    : Effect.succeed(`${os}-${arch}`);
}

/** One parsed release: its version plus the expected digest of every asset. */
export interface ReleaseChecksums {
  readonly version: string;
  readonly digests: ReadonlyMap<string, string>;
}

/**
 * A checksums.txt line in `sha256sum` format: `<sha256>  <asset>`, where the
 * asset is `scratchwork-v<version>-<os>-<arch>.tar.gz` (scripts/package-release.ts).
 * The version is everything between `v` and the target, so prerelease
 * versions with their own hyphens (`0.5.0-rc.1`) parse whole.
 */
const CHECKSUM_LINE = /^([0-9a-f]{64})  (scratchwork-v(.+)-(?:darwin|linux)-(?:arm64|x64)\.tar\.gz)$/;

/** Parses checksums.txt; the asset names carry the version. Null when no asset line is present. */
export function parseChecksums(text: string): ReleaseChecksums | null {
  const digests = new Map<string, string>();
  let version: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(CHECKSUM_LINE);
    if (match == null) continue;
    digests.set(match[2]!, match[1]!);
    version ??= match[3]!;
  }
  return version == null ? null : { version, digests };
}

function fetchText(url: string): Effect.Effect<string, CliError, HttpClient.HttpClient> {
  return Effect.flatMap(HttpClient.HttpClient, (client) =>
    HttpClient.filterStatusOk(client)
      .get(url)
      .pipe(
        Effect.flatMap((response) => response.text),
        Effect.mapError(failWith("update", `could not download ${url}`)),
      ),
  );
}

function fetchBytes(url: string): Effect.Effect<Uint8Array, CliError, HttpClient.HttpClient> {
  return Effect.flatMap(HttpClient.HttpClient, (client) =>
    HttpClient.filterStatusOk(client)
      .get(url)
      .pipe(
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.mapError(failWith("update", `could not download ${url}`)),
      ),
  );
}

/** Downloads and parses checksums.txt for SCRATCHWORK_VERSION or the latest release. */
const fetchRelease: Effect.Effect<ReleaseChecksums, CliError, HttpClient.HttpClient> = Effect.gen(function* () {
  const pinned = env("SCRATCHWORK_VERSION");
  const url = pinned
    ? `${downloadBase()}/download/v${pinned}/checksums.txt`
    : `${downloadBase()}/latest/download/checksums.txt`;
  const release = parseChecksums(yield* fetchText(url));
  if (release == null) {
    return yield* Effect.fail(fail("update", `could not read a release version from ${url}`));
  }
  return release;
});

/**
 * Unpacks the release tarball in a scoped temp dir created inside `directory`
 * and returns the extracted binary's path. The directory is the install
 * directory rather than the system temp dir: the binary is executed from
 * here to verify it, and temp filesystems are commonly mounted noexec.
 */
function extractBinary(
  command: SelfCommand,
  asset: string,
  bytes: Uint8Array,
  directory: string,
): Effect.Effect<
  string,
  CliError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor | Scope.Scope
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const tmp = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".scratchwork-update-" });
    const archive = paths.join(tmp, asset);
    yield* fs.writeFile(archive, bytes);
    const code = yield* Command.exitCode(Command.make("tar", "-xzf", archive, "-C", tmp)).pipe(
      Effect.mapError(failWith(command, "could not run tar")),
    );
    if (code !== 0) {
      return yield* Effect.fail(fail(command, `tar failed extracting ${asset}`));
    }
    const binary = paths.join(tmp, "scratchwork");
    if (!(yield* fs.exists(binary))) {
      return yield* Effect.fail(fail(command, `archive ${asset} did not contain a scratchwork binary`));
    }
    yield* fs.chmod(binary, 0o755);
    return binary;
  }).pipe(Effect.mapError(failWith(command, `could not unpack ${asset} in ${directory}`)));
}

/**
 * Replaces `destination` with `source` via a staging file in the destination
 * directory, so the final step is an atomic same-filesystem rename — safe
 * even when `destination` is the currently running binary.
 */
function placeBinary(
  command: SelfCommand,
  source: string,
  destination: string,
): Effect.Effect<void, CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const dir = paths.dirname(destination);
    const staged = paths.join(dir, `.scratchwork-staged-${process.pid}`);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* Effect.gen(function* () {
      yield* fs.copyFile(source, staged);
      yield* fs.chmod(staged, 0o755);
      yield* fs.rename(staged, destination);
    }).pipe(Effect.onError(() => fs.remove(staged).pipe(Effect.ignore)));
  }).pipe(Effect.mapError(failWith(command, `could not write ${destination}`)));
}

/**
 * Runs `<binary> version` to confirm a binary executes, returning its version.
 * Both the exit status and the output are checked: a binary that prints
 * something and then crashes has not been verified.
 */
function verifyRuns(
  command: SelfCommand,
  binary: string,
): Effect.Effect<string, CliError, CommandExecutor.CommandExecutor> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Command.start(Command.make(binary, "version"));
      const [output, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
        { concurrency: "unbounded" },
      );
      const version = output.trim();
      if (code !== 0 || version === "") {
        return yield* Effect.fail(fail(command, `${binary} failed to run (exit ${code}, printed ${JSON.stringify(version)})`));
      }
      return version;
    }),
  ).pipe(Effect.mapError(failWith(command, `${binary} failed to run`)));
}

/** Advice printed when the install directory is missing from PATH, or null when it is on it. */
function pathAdvice(dir: string): string | null {
  if ((process.env.PATH ?? "").split(":").includes(dir)) return null;
  return `\n${dir} is not on your PATH. Add it, e.g.:\n  export PATH="${dir}:$PATH"`;
}

/**
 * Runs `scratchwork install`: copies the running binary into the install
 * directory (--dir, SCRATCHWORK_INSTALL_DIR, or ~/.local/bin), verifies it
 * runs, and prints PATH advice when the directory is not on PATH.
 */
export function runInstall(config: {
  readonly dir?: string | undefined;
}): Effect.Effect<void, CliError, FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor> {
  return Effect.gen(function* () {
    const paths = yield* Path.Path;
    const self = yield* selfBinary("install");
    const home = env("HOME");
    const requested = config.dir ?? env("SCRATCHWORK_INSTALL_DIR") ?? (home ? paths.join(home, ".local", "bin") : null);
    if (requested == null) {
      return yield* Effect.fail(fail("install", "HOME is not set; pass --dir or set SCRATCHWORK_INSTALL_DIR"));
    }
    const dir = paths.resolve(process.cwd(), requested);
    const destination = paths.join(dir, "scratchwork");
    yield* placeBinary("install", self, destination);
    const version = yield* verifyRuns("install", destination);
    yield* Console.log(`Installed ${destination}`);
    yield* Console.log(`scratchwork ${version} is ready.`);
    const advice = pathAdvice(dir);
    if (advice != null) yield* Console.log(advice);
  });
}

/**
 * Runs `scratchwork update`: replaces the running binary with the latest
 * release (or SCRATCHWORK_VERSION) for this platform, after verifying the
 * download against the release's checksums.txt and confirming the unpacked
 * binary runs. The running binary is untouched until both checks pass.
 */
export function runUpdate(): Effect.Effect<
  void,
  CliError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor | HttpClient.HttpClient
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const paths = yield* Path.Path;
      const self = yield* selfBinary("update");
      const target = yield* releaseTarget("update");
      const release = yield* fetchRelease;
      if (release.version === pkg.version) {
        return yield* Console.log(
          env("SCRATCHWORK_VERSION")
            ? `scratchwork is already version ${pkg.version}.`
            : `scratchwork ${pkg.version} is already the latest version.`,
        );
      }
      const asset = `scratchwork-v${release.version}-${target}.tar.gz`;
      const expected = release.digests.get(asset);
      if (expected == null) {
        return yield* Effect.fail(fail("update", `release v${release.version} has no prebuilt binary for ${target}`));
      }
      yield* Console.log(`Downloading scratchwork v${release.version} (${target})...`);
      const bytes = yield* fetchBytes(`${downloadBase()}/download/v${release.version}/${asset}`);
      const actual = yield* Effect.tryPromise({
        try: () => sha256Hex(bytes),
        catch: failWith("update", `could not hash ${asset}`),
      });
      if (actual !== expected) {
        return yield* Effect.fail(fail("update", `checksum mismatch for ${asset}: expected ${expected}, got ${actual}`));
      }
      const extracted = yield* extractBinary("update", asset, bytes, paths.dirname(self));
      yield* verifyRuns("update", extracted);
      yield* placeBinary("update", extracted, self);
      yield* Console.log(`Updated ${self}: ${pkg.version} -> ${release.version}`);
    }),
  );
}
