/*
 * e2e: --version/--help, project commands (info/share/revoke/delete/clone),
 * login, example, and template. Shared harness: e2e-helpers.js.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ENGINE,
  RENDERER_MARKER,
  CLI,
  nextPort,
  spawnServer,
  waitForReady,
  readOutputUntil,
  httpGet,
  runCli,
} from "./e2e-helpers.js";

describe("scratchwork --version", () => {
  test("prints a semver-ish version and exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-ver-"));
    try {
      const { code, stdout } = await runCli(["--version"], dir);
      expect(code).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scratchwork --help", () => {
  test("shows local project commands and omits account commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-help-"));
    try {
      const { code, stdout } = await runCli(["--help"], dir);
      expect(code).toBe(0);
      expect(stdout).toContain("dev");
      expect(stdout).toContain("example");
      expect(stdout).toContain("info");
      expect(stdout).toContain("login");
      expect(stdout).toContain("me");
      expect(stdout).toContain("projects");
      expect(stdout).toContain("publish");
      expect(stdout).toContain("revoke");
      expect(stdout).toContain("share");
      expect(stdout).toContain("stream");
      expect(stdout).toContain("template");
      expect(stdout).toContain("unpublish");
      expect(stdout).toContain("version");
      expect(stdout).not.toContain("logout");
      expect(stdout).not.toContain("whoami");
      expect(stdout).not.toContain("tokens");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scratchwork project commands", () => {
  test("lists, inspects, shares, revokes, unpublishes, deletes, and clones projects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-project-cmds-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;
    const seen = [];
    const shareBodies = [];
    const project = {
      project: "site",
      isPublic: true,
      url: `${serverUrl}/site/`,
      owner: { id: "owner-1", email: "owner@example.com" },
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z",
      currentOpenPath: "/",
      fileCount: 1,
      totalBytes: 5,
    };

    const server = Bun.serve({
      port,
      async fetch(request) {
        const url = new URL(request.url);
        seen.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/api/projects") return Response.json({ projects: [project] });
        if (url.pathname === "/api/resolve" && url.searchParams.get("path") === "/site/") {
          return Response.json({ project });
        }
        if (url.pathname === "/api/projects/site" && request.method === "GET") return Response.json({ project });
        if (url.pathname === "/api/projects/site/unpublish" && request.method === "POST") {
          return Response.json({ project: { ...project, isPublic: false } });
        }
        if (url.pathname === "/api/projects/site/share" && request.method === "POST") {
          const body = await request.json();
          shareBodies.push(body);
          const read = body.add != null ? ["alice@example.com", "@example.com"] : ["@example.com"];
          return Response.json({
            project: { ...project, permissions: { read, write: [], admin: [] } },
            warnings: [],
          });
        }
        if (url.pathname === "/api/projects/site" && request.method === "DELETE") return Response.json({ ok: true });
        if (url.pathname === "/api/projects/site/bundle") {
          return Response.json({
            bundle: {
              version: 1,
              files: [{ path: "index.html", contentBase64: btoa("<h1>cloned</h1>") }],
            },
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    try {
      expect((await runCli(["projects", "--server", serverUrl], dir)).stdout).toContain(`site\tpublic\t${serverUrl}/site/`);
      expect((await runCli(["info", "--server", serverUrl, "--project", "site"], dir)).stdout).toContain('"project": "site"');
      expect((await runCli(["unpublish", "--server", serverUrl, "--project", "site"], dir)).stdout).toContain('"isPublic": false');
      expect((await runCli(["share", "alice@example.com", "@example.com", "--server", serverUrl, "--project", "site"], dir)).stdout)
        .toContain('"alice@example.com"');
      expect((await runCli(["share", "--role", "write", "bob@example.com", "--server", serverUrl, "--project", "site"], dir)).code)
        .toBe(0);
      // Targets and the project URL mix as positionals; anything with an "@" is a target.
      const revoked = (await runCli(["revoke", "alice@example.com", `${serverUrl}/site/`], dir)).stdout;
      expect(revoked).toContain('"@example.com"');
      expect(revoked).not.toContain('"alice@example.com"');
      expect(shareBodies).toEqual([
        { add: ["alice@example.com", "@example.com"], role: "read" },
        { add: ["bob@example.com"], role: "write" },
        { remove: ["alice@example.com"] },
      ]);
      const badRole = await runCli(["share", "--role", "owner", "alice@example.com", "--server", serverUrl, "--project", "site"], dir);
      expect(badRole.code).toBe(1);
      const noTargets = await runCli(["share", "--server", serverUrl, "--project", "site"], dir);
      expect(noTargets.code).toBe(1);
      expect(noTargets.stderr).toContain("pass at least one email address or @domain group");
      expect((await runCli(["delete", "--server", serverUrl, "--project", "site"], dir)).stdout).toContain("Deleted site");
      expect((await runCli(["info", `${serverUrl}/site/`], dir)).stdout).toContain('"project": "site"');
      expect((await runCli(["unpublish", `${serverUrl}/site/`], dir)).stdout).toContain('"isPublic": false');
      expect((await runCli(["delete", `${serverUrl}/site/`], dir)).stdout).toContain("Deleted site");
      expect((await runCli(["clone", `${serverUrl}/site/`], dir)).stdout).toContain("Cloned site");
      expect(readFileSync(join(dir, "site", "index.html"), "utf8")).toBe("<h1>cloned</h1>");
      // Clone writes identity into the destination so a republish (even after a
      // directory rename) updates the same project.
      expect(JSON.parse(readFileSync(join(dir, "site", ".scratchwork.json"), "utf8"))).toEqual({
        server: serverUrl,
        project: "site",
      });
      expect(seen).toContain("GET /api/projects");
      expect(seen).toContain("GET /api/resolve");
      expect(seen).toContain("POST /api/projects/site/unpublish");
      expect(seen).toContain("POST /api/projects/site/share");
      expect(seen).toContain("DELETE /api/projects/site");
      expect(seen).toContain("GET /api/projects/site/bundle");
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
    // Explicit timeout: this test spawns ~14 sequential CLI processes, which
    // takes ~7s on CI runners — bun's 5s default kills it mid-run and the
    // leaked assertions fail the next test too.
  }, 15000);

  test("share against a server without the /share API explains the version gap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-share-old-server-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;

    // An old server: /share is an unknown route (bare "Not found"), unlike a
    // missing project ("Project not found").
    const server = Bun.serve({
      port,
      async fetch() {
        return Response.json({ error: "Not found" }, { status: 404 });
      },
    });

    try {
      const { code, stderr } = await runCli(["share", "alice@example.com", "--server", serverUrl, "--project", "site"], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("does not support sharing yet");
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HTML error pages are summarized, never dumped into the terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-html-error-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;

    // A crashing edge (Cloudflare, a proxy) answers with a full HTML page.
    const server = Bun.serve({
      port,
      async fetch() {
        return new Response(
          "<!DOCTYPE html>\n<html><head><title>Worker threw exception | Cloudflare</title></head><body><div>lots of markup</div></body></html>",
          { status: 500, headers: { "content-type": "text/html" } },
        );
      },
    });

    try {
      const { code, stderr } = await runCli(["info", "--server", serverUrl, "--project", "site"], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("server returned 500: Worker threw exception | Cloudflare");
      expect(stderr).not.toContain("<!DOCTYPE");
      expect(stderr).not.toContain("<div>");
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clone rejects bundles with path-traversal file paths without writing anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-clone-traversal-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;

    const server = Bun.serve({
      port,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/resolve") {
          return Response.json({
            project: {
              project: "site",
              isPublic: true,
              owner: { id: "owner-1", email: "owner@example.com" },
              createdAt: "2026-06-28T00:00:00.000Z",
              updatedAt: "2026-06-29T00:00:00.000Z",
              currentOpenPath: "/",
              fileCount: 2,
              totalBytes: 30,
            },
          });
        }
        if (url.pathname === "/api/projects/site/bundle") {
          return Response.json({
            bundle: {
              version: 1,
              files: [
                { path: "index.html", contentBase64: btoa("<h1>ok</h1>") },
                { path: "../escape.html", contentBase64: btoa("<h1>escaped</h1>") },
              ],
            },
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    try {
      const { code, stderr } = await runCli(["clone", `${serverUrl}/site/`], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("invalid server response");
      expect(existsSync(join(dir, "escape.html"))).toBe(false);
      expect(existsSync(join(dir, "site", "index.html"))).toBe(false);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scratchwork login", () => {
  test("requires a server when no project config provides one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-login-missing-server-"));
    try {
      const { code, stderr } = await runCli(["login"], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("scratchwork login: server is required");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts the local callback and stores the returned token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-login-"));
    const configDir = mkdtempSync(join(tmpdir(), "scratchwork-login-config-"));
    const serverUrl = "http://localhost:3999";
    const proc = Bun.spawn([...CLI, "login", serverUrl], {
      cwd: dir,
      env: { ...process.env, SCRATCHWORK_NO_OPEN: "1", SCRATCHWORK_HOME: configDir },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const output = await readOutputUntil(proc, "cli_redirect=");
      const loginMatch = output.match(/https?:\/\/\S+\/auth\/login\?\S+/);
      expect(loginMatch).not.toBeNull();
      const login = new URL(loginMatch[0]);
      const callback = new URL(login.searchParams.get("cli_redirect"));
      callback.searchParams.set("token", "login-token");
      callback.searchParams.set("server", serverUrl);
      callback.searchParams.set("email", "founder@example.com");

      const response = await fetch(callback);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("login complete");

      const [stderr, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");

      const auth = JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8"));
      expect(auth.servers[serverUrl].token).toBe("login-token");
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// `scratchwork example [path]` — writes runnable example content.
// ===========================================================================
describe("scratchwork example", () => {
  test("writes example .md + components into the target dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-example-"));
    try {
      const { code, stdout } = await runCli(["example", "site"], dir);
      expect(code).toBe(0);
      expect(stdout).toContain("Wrote Scratchwork example files");

      // The example lands on disk…
      expect(existsSync(join(dir, "site", "index.md"))).toBe(true);
      expect(existsSync(join(dir, "site", "components", "Counter.js"))).toBe(true);

      // …and the index.md references the component it ships, so it renders.
      const md = readFileSync(join(dir, "site", "index.md"), "utf8");
      expect(md).toContain("<Counter />");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the example project actually serves through `scratchwork dev`", async () => {
    // example → then dev the result → the root page renders via a shell and the
    // example index.md is fetchable raw.
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-example-dev-"));
    try {
      expect((await runCli(["example", "."], dir)).code).toBe(0);
      const proc = spawnServer(dir);
      try {
        const { port } = await waitForReady(proc);
        expect((await httpGet(port, "/")).status).toBe(200); // root renders (baked shell)
        const md = await httpGet(port, "/index.md");
        expect(md.status).toBe(200);
        expect(md.body).toContain("<Counter />"); // the example content, raw
        expect((await httpGet(port, "/components/Counter.js")).status).toBe(200);
      } finally {
        proc.kill();
        await proc.exited;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite existing files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-example-clash-"));
    try {
      writeFileSync(join(dir, "index.md"), "# mine\n");
      const { code, stderr } = await runCli(["example", "."], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("refusing to overwrite");
      expect(readFileSync(join(dir, "index.md"), "utf8")).toBe("# mine\n"); // untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// `scratchwork template [file]` — writes the default Markdown renderer.
// ===========================================================================
describe("scratchwork template", () => {
  test("writes the real renderer to marked index.html by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-template-"));
    try {
      const { code, stdout } = await runCli(["template"], dir);
      expect(code).toBe(0);
      expect(stdout).toContain("index.html");

      const html = readFileSync(join(dir, "index.html"), "utf8");
      expect(html.startsWith(RENDERER_MARKER)).toBe(true);
      expect(html).toContain(ENGINE); // it's the real baked renderer, not a stub
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a copied marked index.html overrides the default when serving markdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-template-dev-"));
    try {
      expect((await runCli(["template"], dir)).code).toBe(0);
      const renderer = join(dir, "index.html");
      writeFileSync(
        renderer,
        readFileSync(renderer, "utf8").replace(
          "</body>",
          "<!-- TEMPLATE MARK --></body>",
        ),
      );
      writeFileSync(join(dir, "page.md"), "# p\n");

      const proc = spawnServer(dir);
      try {
        const { port } = await waitForReady(proc);
        const res = await httpGet(port, "/page");
        expect(res.status).toBe(200);
        expect(res.body).toContain("TEMPLATE MARK");
      } finally {
        proc.kill();
        await proc.exited;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite an existing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-template-clash-"));
    try {
      writeFileSync(join(dir, "index.html"), "KEEP ME");
      const { code, stderr } = await runCli(["template"], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("refusing to overwrite");
      expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("KEEP ME");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
