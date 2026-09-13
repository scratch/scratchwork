# Installing the scratchwork CLI

Scratchwork publishes static HTML and Markdown, publicly and privately: a dev
server with hot reload (`scratchwork dev`), one-command publishing
(`scratchwork publish`), and link sharing (`scratchwork share`). This page is
the complete manual install procedure — written so a human or an agent can
follow it end-to-end without fetching anything else.

## One-liner

```sh
curl -fsSL https://scratchwork.dev/install.sh | bash
```

Installs the latest release to `~/.local/bin/scratchwork`. No sudo, ever.
The script only downloads, verifies, and extracts the release; the binary's
own `scratchwork install` command does the rest (installing, verifying, and
PATH advice). Releases up to v0.3.0 predate that command; the script installs
them itself.

When piping, set environment variables on `bash`, not `curl` — a prefix
assignment applies only to the command it precedes:

- Pin a version: `curl -fsSL https://scratchwork.dev/install.sh | SCRATCHWORK_VERSION=0.3.0 bash`
- Change the destination: `curl -fsSL https://scratchwork.dev/install.sh | SCRATCHWORK_INSTALL_DIR=$HOME/bin bash`
  (default `~/.local/bin`)

## Updating

An installed CLI updates itself — no need to re-run the install script:

```sh
scratchwork update
```

Downloads the latest release for your platform, verifies its checksum,
confirms the new binary runs, and only then replaces the current one in
place. Pin or downgrade with `SCRATCHWORK_VERSION=0.3.0 scratchwork update`.
Re-running the install one-liner also upgrades in place.

## Supported platforms

Prebuilt binaries exist for exactly these targets:

| OS             | Architecture    | Release asset suffix |
| -------------- | --------------- | -------------------- |
| macOS          | arm64 (Apple)   | `darwin-arm64`       |
| macOS          | x64 (Intel)     | `darwin-x64`         |
| Linux (glibc)  | x64             | `linux-x64`          |
| Linux (glibc)  | arm64           | `linux-arm64`        |

Windows and musl-libc Linux (e.g. Alpine) are not supported yet.

## Manual install

Releases live at `https://github.com/scratch/scratchwork/releases`. Each
release `vX.Y.Z` carries one archive per target plus a `checksums.txt`:

```
https://github.com/scratch/scratchwork/releases/download/vX.Y.Z/scratchwork-vX.Y.Z-<os>-<arch>.tar.gz
https://github.com/scratch/scratchwork/releases/download/vX.Y.Z/checksums.txt
```

The latest release is always reachable without knowing its version at
`https://github.com/scratch/scratchwork/releases/latest/download/checksums.txt`
— the asset names inside carry the version number.

Steps (example: macOS arm64, latest release):

```sh
curl -fsSLO https://github.com/scratch/scratchwork/releases/latest/download/checksums.txt
version="$(sed -n 's/^.*scratchwork-v\(.*\)-[a-z]*-[a-z0-9]*\.tar\.gz$/\1/p' checksums.txt | head -n 1)"
curl -fsSLO "https://github.com/scratch/scratchwork/releases/download/v$version/scratchwork-v$version-darwin-arm64.tar.gz"

# Verify: the computed digest must match the asset's line in checksums.txt.
shasum -a 256 -c <(grep darwin-arm64 checksums.txt)   # Linux: sha256sum -c ...

tar -xzf "scratchwork-v$version-darwin-arm64.tar.gz"  # extracts one file: scratchwork
./scratchwork install                                 # installs to ~/.local/bin
```

To pin a version instead, replace `latest/download` with `download/vX.Y.Z`
and set `version=X.Y.Z`.

`scratchwork install` copies the binary into `SCRATCHWORK_INSTALL_DIR`
(default `~/.local/bin`, or pass `--dir <path>`), verifies it runs, and tells
you if the directory is missing from your `PATH`, e.g.:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Prefer fully manual placement — or installing v0.2.0 or v0.3.0, which predate
`scratchwork install`? The extracted `scratchwork` file is the whole install:
move it anywhere on your `PATH` and make it executable.

## Verify the install

```sh
scratchwork --version
```

## Uninstall

```sh
rm ~/.local/bin/scratchwork
```

That's everything — the binary is fully self-contained (the renderer is
embedded) and writes no other files at install time.

## Next steps

Run `scratchwork --help`, or start with `scratchwork dev` in a directory
containing Markdown files. Full documentation: https://scratchwork.dev
