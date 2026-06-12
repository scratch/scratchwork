/*
 * Unit tests for the shared, runtime-agnostic modules (used by both the CLI and
 * the server): the bundle format and the static resolution rule.
 */
import { test, expect, describe } from "bun:test";
import { packBundle, unpackBundle } from "../../shared/bundle.js";
import { candidates, isSafePath } from "../../shared/resolve.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("bundle", () => {
  test("packs and unpacks text + binary, preserving order and bytes", async () => {
    const files = [
      { path: "index.html", data: enc.encode("<html>shell</html>") },
      { path: "a/b/page.md", data: enc.encode("# page\n") },
      { path: "img.bin", data: new Uint8Array([0, 1, 2, 255, 254, 253, 0]) },
    ];
    const back = await unpackBundle(await packBundle(files));
    expect(back.map((f) => f.path)).toEqual(["index.html", "a/b/page.md", "img.bin"]);
    expect(dec.decode(back[0].data)).toBe("<html>shell</html>");
    expect(dec.decode(back[1].data)).toBe("# page\n");
    expect([...back[2].data]).toEqual([0, 1, 2, 255, 254, 253, 0]);
  });

  test("identical files compress well (gzip dedupes the baked shells)", async () => {
    const shell = enc.encode("x".repeat(50000));
    const files = Array.from({ length: 20 }, (_, i) => ({ path: `p${i}.html`, data: shell }));
    const packed = await packBundle(files);
    // 20 × 50 KB = 1 MB raw, but identical → compresses to a tiny fraction.
    expect(packed.byteLength).toBeLessThan(50000);
  });

  test("rejects a corrupt bundle", async () => {
    await expect(unpackBundle(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow();
  });

  test("enforces an uncompressed-size cap (gzip-bomb guard)", async () => {
    // 200 KB of one repeated byte compresses tiny but must be rejected by a cap.
    const bomb = await packBundle([{ path: "x", data: enc.encode("A".repeat(200000)) }]);
    await expect(unpackBundle(bomb, { maxBytes: 1024 })).rejects.toThrow(/uncompressed size limit/);
    // …and unpacks fine when under the cap.
    const ok = await unpackBundle(bomb, { maxBytes: 1024 * 1024 });
    expect(ok[0].data.length).toBe(200000);
  });
});

describe("resolve.candidates (parity with scratchwork dev static resolution)", () => {
  const cases = [
    ["/", ["index.html"]],
    ["/about/", ["about/index.html"]],
    ["/about", ["about.html", "about/index.html"]],
    ["/a/b/page", ["a/b/page.html", "a/b/page/index.html"]],
    ["/style.css", ["style.css"]],
    ["/components/X.js", ["components/X.js"]],
    ["/index.md", ["index.md"]],
  ];
  for (const [path, want] of cases) {
    test(`${path} → ${JSON.stringify(want)}`, () => {
      expect(candidates(path)).toEqual(want);
    });
  }

  test("traversal yields no candidates and isSafePath rejects it", () => {
    expect(candidates("/../secret")).toEqual([]);
    expect(isSafePath("../x")).toBe(false);
    expect(isSafePath("a/b/c.js")).toBe(true);
  });

  test("isSafePath rejects non-string input (no throw)", () => {
    expect(isSafePath(123)).toBe(false);
    expect(isSafePath(null)).toBe(false);
    expect(isSafePath(undefined)).toBe(false);
    expect(isSafePath({})).toBe(false);
  });
});
