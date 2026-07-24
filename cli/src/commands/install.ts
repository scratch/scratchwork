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
 * platform from GitHub Releases, verifies its checksum, and atomically
 * replaces the running binary in place.
 *
 * Both refuse to run from source (`bun src/index.ts`): they operate on the
 * running executable, which for a source run would be Bun itself.
 */
import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as HttpClient from "@effect/platform/HttpClient";
import * as Path from "@effect/platform/Path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { sha256Hex } from "@scratchwork/shared/crypto/digest";
import pkg from "../../package.json";
import { CliError, errorMessage } from "../errors";

/** Release download base; SCRATCHWORK_DOWNLOAD_BASE overrides it (hermetic ci fixture). */
const DOWNLOAD_BASE = "https://github.com/scratch/scratchwork/releases";

const downloadBase = () => process.env.SCRATCHWORK_DOWNLOAD_BASE ?? DOWNLOAD_BASE;

type SelfCommand = "install" | "update";

const fail = (command: SelfCommand, message: string) =>
  new CliError({ code: 1, message: `scratchwork ${command}: ${message}` });

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
interface ReleaseChecksums {
  readonly version: string;
  readonly digests: ReadonlyMap<string, string>;
}

/** Parses checksums.txt (`<sha256>  <asset>` lines); the asset names carry the version. */
function parseChecksums(text: string): ReleaseChecksums | null {
  const digests = new Map<string, string>();
  let version: string | null = null;
  for (const line of text.split("\n")) {
    const match = line.match(/^([0-9a-f]{64})  (scratchwork-v([^-]+)-.+\.tar\.gz)$/);
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
        Effect.mapError((cause) => fail("update", `could not download ${url}: ${errorMessage(cause)}`)),
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
        Effect.mapError((cause) => fail("update", `could not download ${url}: ${errorMessage(cause)}`)),
      ),
  );
}

/** Downloads and parses checksums.txt for SCRATCHWORK_VERSION or the latest release. */
const fetchRelease: Effect.Effect<ReleaseChecksums, CliError, HttpClient.HttpClient> = Effect.gen(function* () {
  const pinned = process.env.SCRATCHWORK_VERSION;
  const url = pinned
    ? `${downloadBase()}/download/v${pinned}/checksums.txt`
    : `${downloadBase()}/latest/download/checksums.txt`;
  const release = parseChecksums(yield* fetchText(url));
  if (release == null) {
    return yield* Effect.fail(fail("update", `could not read a release version from ${url}`));
  }
  return release;
});

/** Unpacks the release tarball in a scoped temp dir and returns the extracted binary's path. */
function extractBinary(
  command: SelfCommand,
  asset: string,
  bytes: Uint8Array,
): Effect.Effect<
  string,
  CliError | PlatformError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor | Scope.Scope
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "scratchwork-release-" });
    const archive = paths.join(tmp, asset);
    yield* fs.writeFile(archive, bytes);
    const code = yield* Command.exitCode(Command.make("tar", "-xzf", archive, "-C", tmp)).pipe(
      Effect.mapError((cause) => fail(command, `could not run tar: ${errorMessage(cause)}`)),
    );
    if (code !== 0) {
      return yield* Effect.fail(fail(command, `tar failed extracting ${asset}`));
    }
    const binary = paths.join(tmp, "scratchwork");
    if (!(yield* fs.exists(binary))) {
      return yield* Effect.fail(fail(command, `archive ${asset} did not contain a scratchwork binary`));
    }
    return binary;
  });
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
  }).pipe(Effect.mapError((cause) => (cause instanceof CliError ? cause : fail(command, `could not write ${destination}: ${errorMessage(cause)}`))));
}

/** Runs `<binary> version` to confirm the installed binary executes, returning its version. */
function verifyRuns(
  command: SelfCommand,
  binary: string,
): Effect.Effect<string, CliError, CommandExecutor.CommandExecutor> {
  return Command.string(Command.make(binary, "version")).pipe(
    Effect.mapError((cause) => fail(command, `the installed binary failed to run: ${errorMessage(cause)}`)),
    Effect.map((output) => output.trim()),
    Effect.filterOrFail(
      (output) => output !== "",
      () => fail(command, "the installed binary failed to run"),
    ),
  );
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
    const home = process.env.HOME;
    const requested =
      config.dir ?? process.env.SCRATCHWORK_INSTALL_DIR ?? (home ? paths.join(home, ".local", "bin") : null);
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
 * download against the release's checksums.txt.
 */
export function runUpdate(): Effect.Effect<
  void,
  CliError | PlatformError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor | HttpClient.HttpClient
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const self = yield* selfBinary("update");
      const target = yield* releaseTarget("update");
      const release = yield* fetchRelease;
      if (release.version === pkg.version) {
        return yield* Console.log(
          process.env.SCRATCHWORK_VERSION
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
        catch: (cause) => fail("update", `could not hash ${asset}: ${errorMessage(cause)}`),
      });
      if (actual !== expected) {
        return yield* Effect.fail(fail("update", `checksum mismatch for ${asset}: expected ${expected}, got ${actual}`));
      }
      const extracted = yield* extractBinary("update", asset, bytes);
      yield* placeBinary("update", extracted, self);
      yield* verifyRuns("update", self);
      yield* Console.log(`Updated ${self}: ${pkg.version} -> ${release.version}`);
    }),
  );
}
