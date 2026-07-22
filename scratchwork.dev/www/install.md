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
Re-running upgrades in place.

- Pin a version: `SCRATCHWORK_VERSION=0.2.0 curl -fsSL https://scratchwork.dev/install.sh | bash`
- Change the destination: set `SCRATCHWORK_INSTALL_DIR` (default `~/.local/bin`)

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

Steps (example: macOS arm64, version 0.2.0):

```sh
curl -fsSLO https://github.com/scratch/scratchwork/releases/download/v0.2.0/scratchwork-v0.2.0-darwin-arm64.tar.gz
curl -fsSLO https://github.com/scratch/scratchwork/releases/download/v0.2.0/checksums.txt

# Verify: the computed digest must match the asset's line in checksums.txt.
shasum -a 256 -c <(grep darwin-arm64 checksums.txt)   # Linux: sha256sum -c ...

tar -xzf scratchwork-v0.2.0-darwin-arm64.tar.gz       # extracts one file: scratchwork
mkdir -p ~/.local/bin
mv scratchwork ~/.local/bin/scratchwork
chmod +x ~/.local/bin/scratchwork
```

Make sure `~/.local/bin` is on your `PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

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
