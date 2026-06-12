/*
 * Server tests. The app handler is runtime-agnostic, so these drive it
 * in-process (no spawn, no network) against the filesystem storage adapter —
 * the exact code path the local server uses, and the same handler the Worker
 * runs in production.
 *
 * Each test: build an app, (optionally) deploy a hand-built bundle, then assert
 * on real Response objects. Bundles are built with the shared packer, so the
 * deploy path is exercised end to end.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { createFsStorage } from "../src/storage-fs.js";
import { packBundle } from "../../shared/bundle.js";

const enc = new TextEncoder();

function freshApp(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sw-srv-test-"));
  const handle = createApp({ storage: createFsStorage(dir), config });
  return { handle, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function file(path, text) {
  return { path, data: enc.encode(text) };
}

const ORIGIN = "http://localhost:8787";
const req = (path, init) => new Request(ORIGIN + path, init);

// Deploy a set of files, return the parsed JSON (incl. project id).
async function deploy(handle, files, query = "name=site") {
  const bundle = await packBundle(files);
  const res = await handle(req(`/api/deploy?${query}`, { method: "POST", body: bundle }));
  return { res, body: await res.json() };
}

describe("api", () => {
  test("health + whoami (open server)", async () => {
    const app = freshApp();
    try {
      expect((await (await app.handle(req("/api/health"))).json()).ok).toBe(true);
      const who = await (await app.handle(req("/api/whoami"))).json();
      expect(who.authRequired).toBe(false);
      expect(who.authenticated).toBe(true);
    } finally {
      app.cleanup();
    }
  });

  test("deploy returns a stable id + url, content is served", async () => {
    const app = freshApp();
    try {
      const { res, body } = await deploy(app.handle, [
        file("index.html", "<body>HOME<div id=root></div></body>"),
        file("index.md", "# hi\n"),
      ]);
      expect(res.status).toBe(201);
      expect(body.ok).toBe(true);
      expect(body.created).toBe(true);
      expect(body.fileCount).toBe(2);
      expect(body.url).toBe(`${ORIGIN}/${body.id}/`);

      const home = await app.handle(req(`/${body.id}/`));
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("HOME");
      expect(home.headers.get("content-type")).toContain("text/html");

      const md = await app.handle(req(`/${body.id}/index.md`));
      expect(await md.text()).toBe("# hi\n");
      expect(md.headers.get("content-type")).toContain("text/plain");
    } finally {
      app.cleanup();
    }
  });

  test("re-publishing with the same id bumps version, keeps the URL", async () => {
    const app = freshApp();
    try {
      const first = await deploy(app.handle, [file("index.html", "<body>V1</body>")]);
      const id = first.body.id;
      const second = await deploy(app.handle, [file("index.html", "<body>V2</body>")], `name=site&id=${id}`);
      expect(second.res.status).toBe(200);
      expect(second.body.id).toBe(id);
      expect(second.body.created).toBe(false);
      expect(second.body.version).toBe(2);
      expect(await (await app.handle(req(`/${id}/`))).text()).toContain("V2");
    } finally {
      app.cleanup();
    }
  });
});

describe("static resolution (matches scratchwork dev)", () => {
  test("extensionless route → .html, dir → index.html, raw files as-is", async () => {
    const app = freshApp();
    try {
      const { body } = await deploy(app.handle, [
        file("index.html", "<body>ROOT</body>"),
        file("about.html", "<body>ABOUT</body>"),
        file("foo/index.html", "<body>FOO</body>"),
        file("components/X.js", "export default 1;\n"),
        file("style.css", "body{}"),
      ]);
      const id = body.id;
      const get = (p) => app.handle(req(`/${id}${p}`));

      expect(await (await get("/")).text()).toContain("ROOT");
      expect(await (await get("/about")).text()).toContain("ABOUT"); // about.html
      expect(await (await get("/foo")).text()).toContain("FOO"); // foo/index.html
      expect(await (await get("/foo/")).text()).toContain("FOO");
      expect((await get("/components/X.js")).headers.get("content-type")).toContain("javascript");
      expect((await get("/style.css")).headers.get("content-type")).toContain("text/css");
    } finally {
      app.cleanup();
    }
  });

  test("default favicon falls back to the figure mark", async () => {
    const app = freshApp();
    try {
      const { body } = await deploy(app.handle, [file("index.html", "<body>x</body>")]);
      const res = await app.handle(req(`/${body.id}/favicon.ico`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      expect(await res.text()).toStartWith("<svg");
    } finally {
      app.cleanup();
    }
  });

  test("404s and unknown projects", async () => {
    const app = freshApp();
    try {
      const { body } = await deploy(app.handle, [file("index.html", "<body>x</body>")]);
      expect((await app.handle(req(`/${body.id}/nope`))).status).toBe(404);
      expect((await app.handle(req(`/${body.id}/missing.md`))).status).toBe(404);
      expect((await app.handle(req(`/doesnotexist/`))).status).toBe(404);
    } finally {
      app.cleanup();
    }
  });

  test("etag → 304 on If-None-Match", async () => {
    const app = freshApp();
    try {
      const { body } = await deploy(app.handle, [file("index.html", "<body>x</body>")]);
      const first = await app.handle(req(`/${body.id}/`));
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();
      const second = await app.handle(req(`/${body.id}/`, { headers: { "if-none-match": etag } }));
      expect(second.status).toBe(304);
    } finally {
      app.cleanup();
    }
  });
});

describe("safety", () => {
  test("encoded traversal in a content URL cannot escape the deploy", async () => {
    const app = freshApp();
    try {
      const { body } = await deploy(app.handle, [file("index.html", "<body>x</body>")]);
      const res = await app.handle(req(`/${body.id}/%2e%2e%2f%2e%2e%2fmeta%2f${body.id}.json`));
      expect(res.status).toBe(404);
    } finally {
      app.cleanup();
    }
  });

  test("a bundle containing a traversal path is rejected at deploy", async () => {
    const app = freshApp();
    try {
      const bundle = await packBundle([file("../evil.txt", "pwned")]);
      const res = await app.handle(req("/api/deploy?name=x", { method: "POST", body: bundle }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("Unsafe");
    } finally {
      app.cleanup();
    }
  });

  test("empty and corrupt bundles are rejected", async () => {
    const app = freshApp();
    try {
      const empty = await packBundle([]);
      expect((await app.handle(req("/api/deploy?name=x", { method: "POST", body: empty }))).status).toBe(400);

      const garbage = new Uint8Array([1, 2, 3, 4, 5]);
      expect((await app.handle(req("/api/deploy?name=x", { method: "POST", body: garbage }))).status).toBe(400);
    } finally {
      app.cleanup();
    }
  });

  test("oversized deploy → 413", async () => {
    const app = freshApp({ maxDeployBytes: 100 });
    try {
      const big = await packBundle([file("index.html", "x".repeat(5000))]);
      const res = await app.handle(req("/api/deploy?name=x", { method: "POST", body: big }));
      expect(res.status).toBe(413);
    } finally {
      app.cleanup();
    }
  });

  test("decompression bomb (small compressed, huge uncompressed) → 413", async () => {
    const app = freshApp({ maxUncompressedBytes: 4096 });
    try {
      // 500 KB of repeated bytes: compresses to well under the 25 MB compressed
      // cap, but blows past the 4 KB uncompressed cap.
      const bomb = await packBundle([file("index.html", "A".repeat(500000))]);
      expect(bomb.byteLength).toBeLessThan(25 * 1024 * 1024);
      const res = await app.handle(req("/api/deploy?name=x", { method: "POST", body: bomb }));
      expect(res.status).toBe(413);
    } finally {
      app.cleanup();
    }
  });

  test("a bundle with a non-string path is a clean 400, not a 500", async () => {
    const app = freshApp();
    try {
      // Hand-craft a bundle whose header declares a numeric path.
      const enc2 = new TextEncoder();
      const header = enc2.encode(JSON.stringify({ v: 1, files: [{ path: 123, size: 3 }] }));
      const magic = enc2.encode("SWB1");
      const payload = enc2.encode("abc");
      const raw = new Uint8Array(magic.length + 4 + header.length + payload.length);
      let o = 0;
      raw.set(magic, o);
      o += magic.length;
      new DataView(raw.buffer).setUint32(o, header.length, true);
      o += 4;
      raw.set(header, o);
      o += header.length;
      raw.set(payload, o);
      const bundle = Bun.gzipSync(raw);

      const res = await app.handle(req("/api/deploy?name=x", { method: "POST", body: bundle }));
      expect(res.status).toBe(400);
    } finally {
      app.cleanup();
    }
  });
});

describe("auth", () => {
  test("deploy requires a valid bearer token when configured", async () => {
    const app = freshApp({ authTokens: ["sekret"] });
    try {
      const bundle = await packBundle([file("index.html", "<body>x</body>")]);

      const noTok = await app.handle(req("/api/deploy?name=x", { method: "POST", body: bundle }));
      expect(noTok.status).toBe(401);

      const badTok = await app.handle(
        req("/api/deploy?name=x", { method: "POST", body: bundle, headers: { authorization: "Bearer nope" } }),
      );
      expect(badTok.status).toBe(401);

      const goodTok = await app.handle(
        req("/api/deploy?name=x", { method: "POST", body: bundle, headers: { authorization: "Bearer sekret" } }),
      );
      expect(goodTok.status).toBe(201);

      const who = await (await app.handle(req("/api/whoami"))).json();
      expect(who.authRequired).toBe(true);
      expect(who.authenticated).toBe(false);
    } finally {
      app.cleanup();
    }
  });
});

describe("subdomain hosting", () => {
  test("<id>.<baseDomain> serves that project at the host root", async () => {
    const app = freshApp({ baseDomain: "scratchwork.test" });
    try {
      const { body } = await deploy(app.handle, [file("index.html", "<body>SUB</body>")]);
      const res = await app.handle(
        new Request("http://x/", { headers: { host: `${body.id}.scratchwork.test` } }),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("SUB");
    } finally {
      app.cleanup();
    }
  });
});
