#!/bin/sh
# Bootstraps the scratchwork CLI from GitHub Releases: downloads the release
# archive for this platform, verifies its checksum, and hands off to the
# binary's own `scratchwork install` for everything after that (choosing the
# install directory, installing, and PATH advice).
#
#   curl -fsSL https://scratchwork.dev/install.sh | bash
#
# Environment:
#   SCRATCHWORK_VERSION        pin a version (e.g. 0.2.0); default: latest release
#   SCRATCHWORK_INSTALL_DIR    install destination, read by `scratchwork install`;
#                              default: ~/.local/bin
#   SCRATCHWORK_DOWNLOAD_BASE  override the release download base URL (used by
#                              the hermetic ci test; default: GitHub Releases)
#
# The script never escalates privileges. Re-running upgrades in place, and an
# installed CLI can upgrade itself with `scratchwork update`.
# Agent-readable manual steps: https://scratchwork.dev/install.md

set -euf

base="${SCRATCHWORK_DOWNLOAD_BASE:-https://github.com/scratch/scratchwork/releases}"
version="${SCRATCHWORK_VERSION:-}"

fail() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

# ── Map uname to a release target ───────────────────────────────────────────
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported operating system: $os. Prebuilt binaries cover macOS and glibc Linux only — Windows is not supported yet. See https://github.com/scratch/scratchwork for building from source." ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail "unsupported architecture: $arch. Prebuilt binaries cover arm64 and x64 only." ;;
esac
if [ "$os" = linux ] && command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
  fail "musl libc detected (Alpine?). Prebuilt binaries are glibc-only for now — musl is an explicit non-goal for v0."
fi

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required to verify the download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

# ── Fetch checksums.txt; its asset names carry the release version, so the
#    "latest" case needs no GitHub API call ─────────────────────────────────
if [ -n "$version" ]; then
  checksums_url="$base/download/v$version/checksums.txt"
else
  checksums_url="$base/latest/download/checksums.txt"
fi
curl -fsSL "$checksums_url" -o "$tmp/checksums.txt" || fail "could not download $checksums_url"
if [ -z "$version" ]; then
  version="$(sed -n 's/^.*scratchwork-v\([^-][^-]*\)-.*\.tar\.gz$/\1/p' "$tmp/checksums.txt" | head -n 1)"
  [ -n "$version" ] || fail "could not read the latest version from checksums.txt"
fi

asset="scratchwork-v$version-$os-$arch.tar.gz"
expected="$(grep -F "  $asset" "$tmp/checksums.txt" | cut -d' ' -f1 || true)"
[ -n "$expected" ] || fail "release v$version has no prebuilt binary for $os-$arch"

# ── Download, verify, extract ───────────────────────────────────────────────
printf 'Downloading scratchwork v%s (%s-%s)...\n' "$version" "$os" "$arch"
curl -fsSL "$base/download/v$version/$asset" -o "$tmp/$asset" || fail "could not download $base/download/v$version/$asset"
actual="$(sha256 "$tmp/$asset")"
[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset: expected $expected, got $actual"

tar -xzf "$tmp/$asset" -C "$tmp"
[ -f "$tmp/scratchwork" ] || fail "archive $asset did not contain a scratchwork binary"
chmod 755 "$tmp/scratchwork"

# ── Hand off to the verified binary for the actual install ──────────────────
"$tmp/scratchwork" install || fail "scratchwork install failed"
