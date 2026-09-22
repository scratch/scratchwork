/*
 * e2e: `scratchwork publish` and `stream` — bundling, project naming,
 * publish/auth safety. Shared harness: e2e-helpers.js.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  staticPage,
  CLI,
  nextPort,
  readOutputUntil,
  runCli,
} from "./e2e-helpers.js";

describe("scratchwork publish", () => {
  test("reuses .scratchwork.json server and omits publish metadata from the bundle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-publish-"));
    const configDir = mkdtempSync(join(tmpdir(), "scratchwork-config-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;
    const authToken = "signed-auth-token";
    let publishBody;
    let authorization;

    const server = Bun.serve({
      port,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/api/publish");
        authorization = request.headers.get("authorization");
        publishBody = await request.json();
        return Response.json({
          project: publishBody.project,
          isPublic: publishBody.isPublic ?? true,
          openPath: publishBody.openPath,
          url: `${serverUrl}/${publishBody.project}/`,
        });
      },
    });

    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "auth.json"),
        `${JSON.stringify(
          {
            version: 1,
            servers: {
              [serverUrl]: {
                token: authToken,
                email: "founder@example.com",
                updatedAt: "2026-06-29T00:00:00.000Z",
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(join(dir, "index.html"), staticPage("publish"));
      writeFileSync(
        join(dir, ".scratchwork.json"),
        `${JSON.stringify(
          {
            server: serverUrl,
            project: "site",
            isPublic: true,
            url: `${serverUrl}/site/`,
            updatedAt: "2026-06-29T00:00:00.000Z",
          },
          null,
          2,
        )}\n`,
      );

      const { code, stdout, stderr } = await runCli(["publish", "index.html"], dir, {
        env: { SCRATCHWORK_HOME: configDir },
      });

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(`${serverUrl}/site/`);
      expect(authorization).toBe(`Bearer ${authToken}`);
      expect("workspace" in publishBody).toBe(false);
      expect(publishBody.project).toBe("site");
      expect(publishBody.isPublic).toBe(true);
      expect(publishBody.bundle.files.map((file) => file.path)).toEqual(["index.html"]);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("sends commentsEnabled, saves it, and enforces the comments flag rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-publish-"));
    const configDir = mkdtempSync(join(tmpdir(), "scratchwork-config-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;
    let publishBody;

    const server = Bun.serve({
      port,
      async fetch(request) {
        publishBody = await request.json();
        return Response.json({
          project: publishBody.project,
          isPublic: publishBody.isPublic ?? false,
          commentsEnabled: publishBody.commentsEnabled ?? false,
          openPath: publishBody.openPath,
          url: `${serverUrl}/${publishBody.project}/`,
        });
      },
    });

    try {
      writeFileSync(join(dir, "index.html"), staticPage("comments"));

      const conflictingFlags = await runCli(
        ["publish", ".", "--server", serverUrl, "--comments", "--no-comments"],
        dir,
        { env: { SCRATCHWORK_HOME: configDir } },
      );
      expect(conflictingFlags.code).toBe(1);
      expect(conflictingFlags.stderr).toContain("at most one of --comments and --no-comments");

      // The comments+public contradiction fails before anything is uploaded.
      const publicComments = await runCli(
        ["publish", ".", "--server", serverUrl, "--public", "--comments"],
        dir,
        { env: { SCRATCHWORK_HOME: configDir } },
      );
      expect(publicComments.code).toBe(1);
      expect(publicComments.stderr).toContain("comments require a private project");
      expect(publishBody).toBeUndefined();

      const { code, stdout, stderr } = await runCli(
        ["publish", ".", "--server", serverUrl, "--private", "--comments", "--project", "site"],
        dir,
        { env: { SCRATCHWORK_HOME: configDir } },
      );
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(publishBody.commentsEnabled).toBe(true);
      expect(publishBody.isPublic).toBe(false);
      expect(stdout).toContain("comments enabled");
      const saved = JSON.parse(readFileSync(join(dir, ".scratchwork.json"), "utf8"));
      expect(saved.commentsEnabled).toBe(true);

      // A later publish without the flags reuses the saved setting.
      publishBody = undefined;
      const again = await runCli(["publish", "."], dir, { env: { SCRATCHWORK_HOME: configDir } });
      expect(again.code).toBe(0);
      expect(publishBody.commentsEnabled).toBe(true);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("publishing a directory without an index sends the first page file's route as openPath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-publish-"));
    const configDir = mkdtempSync(join(tmpdir(), "scratchwork-config-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;
    let publishBody;

    const server = Bun.serve({
      port,
      async fetch(request) {
        publishBody = await request.json();
        return Response.json({
          project: publishBody.project,
          isPublic: true,
          openPath: publishBody.openPath,
          url: `${serverUrl}/${publishBody.project}${publishBody.openPath}`,
        });
      },
    });

    try {
      writeFileSync(join(dir, "notes.md"), "# notes\n");
      writeFileSync(join(dir, "styles.css"), "body {}");

      const { code, stdout, stderr } = await runCli(["publish", ".", "--server", serverUrl], dir, {
        env: { SCRATCHWORK_HOME: configDir },
      });

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(publishBody.openPath).toBe("/notes");
      expect(stdout).toContain("/notes"); // the printed (and opened) URL points at a real page
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("scratchwork stream", () => {
  test("requires a previously published project config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-stream-unpublished-"));
    try {
      writeFileSync(join(dir, "index.html"), staticPage("stream"));
      const { code, stderr } = await runCli(["stream", "."], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("scratchwork stream: server is required");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("publishes once, then republishes when a watched file changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-stream-"));
    const configDir = mkdtempSync(join(tmpdir(), "scratchwork-stream-config-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;
    const publishes = [];

    const server = Bun.serve({
      port,
      async fetch(request) {
        publishes.push(await request.json());
        return Response.json({
          project: "site",
          isPublic: true,
          openPath: "/",
          url: `${serverUrl}/site/`,
        });
      },
    });

    writeFileSync(join(dir, "index.html"), staticPage("stream-v1"));
    writeFileSync(
      join(dir, ".scratchwork.json"),
      `${JSON.stringify({ server: serverUrl, project: "site" }, null, 2)}\n`,
    );

    const proc = Bun.spawn([...CLI, "stream", "."], {
      cwd: dir,
      // SCRATCHWORK_HOME isolates the test from the developer's real auth.json.
      env: { ...process.env, SCRATCHWORK_NO_OPEN: "1", SCRATCHWORK_HOME: configDir },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      await readOutputUntil(proc, "Streaming changes");
      expect(publishes.length).toBe(1);

      // A content change must trigger a second publish carrying the new bytes.
      // The watcher arms asynchronously after "Streaming changes" prints, so a
      // single early write can slip through before it's watching — keep
      // rewriting until the republish lands. Writes are spaced past the 250ms
      // debounce so they can't keep resetting it forever.
      const deadline = Date.now() + 8000;
      while (publishes.length < 2 && Date.now() < deadline) {
        writeFileSync(join(dir, "index.html"), staticPage("stream-v2"));
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      expect(publishes.length).toBeGreaterThanOrEqual(2);
      const last = publishes[publishes.length - 1];
      const contents = Buffer.from(
        last.bundle.files.find((file) => file.path === "index.html").contentBase64,
        "base64",
      ).toString("utf8");
      expect(contents).toContain("static@stream-v2");
    } finally {
      proc.kill();
      await proc.exited;
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
    // Explicit timeout: the poll deadline above (8s) must be reachable, and
    // bun's 5s default would kill the test first, leaving a dangling process
    // that corrupts later tests.
  }, 15000);
});

describe("publish and auth safety", () => {
  test("publishing a subdirectory does not reuse the ancestor's project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-subdir-publish-"));
    const configDir = mkdtempSync(join(tmpdir(), "scratchwork-subdir-publish-config-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;
    let publishBody;

    const server = Bun.serve({
      port,
      async fetch(request) {
        publishBody = await request.json();
        return Response.json({
          project: publishBody.project,
          isPublic: true,
          openPath: "/",
          url: `${serverUrl}/${publishBody.project}/`,
        });
      },
    });

    try {
      // The ancestor config names the parent project; only its server may be
      // inherited when publishing the docs/ subdirectory.
      writeFileSync(
        join(dir, ".scratchwork.json"),
        `${JSON.stringify({ server: serverUrl, project: "parent-site" }, null, 2)}\n`,
      );
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs", "index.html"), staticPage("docs"));

      const { code } = await runCli(["publish", "docs"], dir, {
        env: { SCRATCHWORK_HOME: configDir },
      });
      expect(code).toBe(0);
      expect(publishBody.project).toBe("docs");
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("a corrupt auth.json fails loudly instead of acting logged out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-corrupt-auth-"));
    const configDir = mkdtempSync(join(tmpdir(), "scratchwork-corrupt-auth-config-"));
    try {
      writeFileSync(join(configDir, "auth.json"), "{ this is not json");
      const { code, stderr } = await runCli(["me", "--server", "http://localhost:9"], dir, {
        env: { SCRATCHWORK_HOME: configDir },
      });
      expect(code).toBe(1);
      expect(stderr).toContain("is corrupt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("clone refuses a project name that would escape the destination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-clone-escape-"));
    try {
      writeFileSync(
        join(dir, ".scratchwork.json"),
        `${JSON.stringify({ server: "http://localhost:9", project: "../evil" }, null, 2)}\n`,
      );
      const { code, stderr } = await runCli(["clone", "."], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("unsafe project name");
      expect(existsSync(join(dirname(dir), "evil"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("project naming", () => {
  /** Starts a fake publish server that echoes the request's project (or assigns one). */
  function publishEcho(port, serverUrl, bodies, assignedName) {
    return Bun.serve({
      port,
      async fetch(request) {
        const body = await request.json();
        bodies.push(body);
        if (assignedName == null && body.project == null) {
          return Response.json({ error: "project name is required (pass --project)" }, { status: 400 });
        }
        const project = assignedName ?? body.project;
        return Response.json({
          project,
          isPublic: true,
          openPath: body.openPath ?? "/",
          url: `${serverUrl}/${project}/`,
        });
      },
    });
  }

  test("derives the project name from the file stem or the directory name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-naming-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;
    const bodies = [];
    const server = publishEcho(port, serverUrl, bodies);

    try {
      const cases = [
        ["notes.md", "notes"],
        ["report.v2.md", "report.v2"],
        ["data.tar.gz", "data.tar"],
        ["Makefile", "makefile"],
      ];
      for (const [filename, expected] of cases) {
        const sub = join(dir, `case-${expected.replace(/[^a-z0-9]+/g, "-")}`);
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, filename), "# hello\n");
        const { code } = await runCli(["publish", join(sub, filename), "--server", serverUrl], dir);
        expect(code).toBe(0);
        expect(bodies[bodies.length - 1].project).toBe(expected);
      }

      // A directory target derives from its basename.
      const project = join(dir, "my-project");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "index.html"), staticPage("naming"));
      const { code } = await runCli(["publish", project, "--server", serverUrl], dir);
      expect(code).toBe(0);
      expect(bodies[bodies.length - 1].project).toBe("my-project");
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit --project beats every derived default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-naming-explicit-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;
    const bodies = [];
    const server = publishEcho(port, serverUrl, bodies);

    try {
      writeFileSync(join(dir, "notes.md"), "# hello\n");
      const { code } = await runCli(["publish", "notes.md", "--server", serverUrl, "--project", "custom-name"], dir);
      expect(code).toBe(0);
      expect(bodies[0].project).toBe("custom-name");

      const invalid = await runCli(["publish", "notes.md", "--server", serverUrl, "--project", "Docs"], dir);
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain("invalid project Docs");
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file publish bundles its siblings and later reuses the saved project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-naming-siblings-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;
    const bodies = [];
    const server = publishEcho(port, serverUrl, bodies);

    try {
      writeFileSync(join(dir, "report.md"), "# report\n");
      writeFileSync(join(dir, "style.css"), "body {}\n");

      const first = await runCli(["publish", "report.md", "--server", serverUrl], dir);
      expect(first.code).toBe(0);
      expect(bodies[0].project).toBe("report");
      // The publish root stays the containing directory, so sibling assets ride along.
      expect(bodies[0].bundle.files.map((file) => file.path).sort()).toEqual(["report.md", "style.css"]);

      // A second sibling file reuses the directory's saved project instead of
      // inferring a second identity from its own stem.
      writeFileSync(join(dir, "notes.md"), "# notes\n");
      const second = await runCli(["publish", "notes.md", "--server", serverUrl], dir);
      expect(second.code).toBe(0);
      expect(bodies[1].project).toBe("report");
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an underivable name sends no project and maps the server's 400", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-naming-underivable-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;
    const bodies = [];
    const server = publishEcho(port, serverUrl, bodies);

    try {
      writeFileSync(join(dir, "日本語.md"), "# hello\n");
      const { code, stderr } = await runCli(["publish", "日本語.md", "--server", serverUrl], dir);
      expect(code).toBe(1);
      expect("project" in bodies[0]).toBe(false);
      expect(stderr).toContain('cannot derive a project name from "日本語.md"; use --project');
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a workspace-era .scratchwork.json fails with an explicit error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-naming-legacy-"));
    try {
      writeFileSync(join(dir, "index.html"), staticPage("legacy"));
      writeFileSync(
        join(dir, ".scratchwork.json"),
        `${JSON.stringify({ server: "http://localhost:9", workspace: "founder", project: "site" }, null, 2)}\n`,
      );
      const { code, stderr } = await runCli(["publish", "."], dir);
      expect(code).toBe(1);
      expect(stderr).toContain('legacy field "workspace"');
      expect(stderr).toContain("republish");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("saves and reuses a server-assigned random name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-naming-random-"));
    const port = nextPort();
    const serverUrl = `http://localhost:${port}`;
    const bodies = [];
    const server = publishEcho(port, serverUrl, bodies, "x7k2mqp3ra");

    try {
      const project = join(dir, "mysite");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "index.html"), staticPage("random"));

      // First publish sends the derived candidate; the server assigns a slug and the
      // CLI both surfaces it and saves it as the project's identity.
      const first = await runCli(["publish", project, "--server", serverUrl], dir);
      expect(first.code).toBe(0);
      expect(bodies[0].project).toBe("mysite");
      expect(first.stdout).toContain('server assigned project name "x7k2mqp3ra"');
      const saved = JSON.parse(readFileSync(join(project, ".scratchwork.json"), "utf8"));
      expect(saved.project).toBe("x7k2mqp3ra");

      // The second publish echoes the saved slug, updating the same project.
      const second = await runCli(["publish", project, "--server", serverUrl], dir);
      expect(second.code).toBe(0);
      expect(bodies[1].project).toBe("x7k2mqp3ra");
      expect(second.stdout).not.toContain("server assigned project name");
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
