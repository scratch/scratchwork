/*
 * Unit tests for the release-metadata parsing behind `scratchwork update`.
 * The end-to-end install/update flow against a fixture release server runs in
 * scripts/check-install-sh.ts; this file pins the checksums.txt parser, whose
 * contract is the asset naming in scripts/release-targets.ts.
 */
import { describe, expect, test } from "bun:test";
import { parseChecksums } from "../src/commands/install";

const digest = (fill) => fill.repeat(64);

describe("parseChecksums", () => {
  test("reads the version and every asset digest from a sha256sum-format file", () => {
    const text = [
      `${digest("a")}  scratchwork-v0.4.0-darwin-arm64.tar.gz`,
      `${digest("b")}  scratchwork-v0.4.0-darwin-x64.tar.gz`,
      `${digest("c")}  scratchwork-v0.4.0-linux-x64.tar.gz`,
      `${digest("d")}  scratchwork-v0.4.0-linux-arm64.tar.gz`,
      "",
    ].join("\n");
    const release = parseChecksums(text);
    expect(release?.version).toBe("0.4.0");
    expect(release?.digests.size).toBe(4);
    expect(release?.digests.get("scratchwork-v0.4.0-linux-arm64.tar.gz")).toBe(digest("d"));
  });

  test("keeps prerelease versions whole, hyphens included", () => {
    const release = parseChecksums(`${digest("a")}  scratchwork-v0.5.0-rc.1-darwin-arm64.tar.gz\n`);
    expect(release?.version).toBe("0.5.0-rc.1");
    expect(release?.digests.has("scratchwork-v0.5.0-rc.1-darwin-arm64.tar.gz")).toBe(true);
  });

  test("tolerates CRLF line endings and blank lines", () => {
    const release = parseChecksums(`\r\n${digest("a")}  scratchwork-v0.4.0-linux-x64.tar.gz\r\n\r\n`);
    expect(release?.version).toBe("0.4.0");
    expect(release?.digests.get("scratchwork-v0.4.0-linux-x64.tar.gz")).toBe(digest("a"));
  });

  test("ignores lines that are not release assets", () => {
    const text = [
      "# comment",
      `${digest("a")}  checksums.txt`,
      `${digest("b")}  scratchwork-v0.4.0-windows-x64.zip`,
      `deadbeef  scratchwork-v0.4.0-linux-x64.tar.gz`,
      `${digest("c")}  scratchwork-v0.4.0-linux-x64.tar.gz`,
    ].join("\n");
    const release = parseChecksums(text);
    expect(release?.version).toBe("0.4.0");
    expect([...release.digests.keys()]).toEqual(["scratchwork-v0.4.0-linux-x64.tar.gz"]);
  });

  test("returns null when no asset line is present", () => {
    expect(parseChecksums("")).toBeNull();
    expect(parseChecksums("not a checksums file\n")).toBeNull();
  });

  test("reports the first asset's version when a file mixes versions", () => {
    const text = [
      `${digest("a")}  scratchwork-v0.4.0-linux-x64.tar.gz`,
      `${digest("b")}  scratchwork-v0.3.0-linux-x64.tar.gz`,
    ].join("\n");
    expect(parseChecksums(text)?.version).toBe("0.4.0");
  });
});
