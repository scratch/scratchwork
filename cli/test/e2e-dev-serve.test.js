/*
 * e2e: `scratchwork dev` serving — static HTML, markdown through renderer
 * shells, raw files, hot reload, and 404/403 safety. Shared harness: e2e-helpers.js.
 */
import { test, expect, describe } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  RELOAD,
  ENGINE,
  fakeShell,
  staticPage,
  makeFixture,
  spawnServer,
  waitForReady,
  httpGet,
  httpGetNoRedirect,
  withServer,
} from "./e2e-helpers.js";

describe("(3) static HTML served directly", () => {
  test("/about.html → /about", async () => {
    await withServer({ "about.html": staticPage("about") }, async ({ port }) => {
      const res = await httpGetNoRedirect(port, "/about.html");
      expect(res.status).toBe(308);
      expect(res.location).toBe("/about");
    });
  });

  test("/foo/index.html → /foo/", async () => {
    await withServer({ "foo/index.html": staticPage("foo-index") }, async ({ port }) => {
      const res = await httpGetNoRedirect(port, "/foo/index.html");
      expect(res.status).toBe(308);
      expect(res.location).toBe("/foo/");
    });
  });

  test("/about → about.html", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "about.html": staticPage("about") },
      async ({ get }) => {
        const res = await get("/about");
        expect(res.status).toBe(200);
        expect(res.body).toContain("static@about"); // the authored page
        expect(res.body).not.toContain("shell@"); // NOT the renderer shell
      },
    );
  });

  test("/foo → foo/index.html", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "foo/index.html": staticPage("foo-index") },
      async ({ get }) => {
        const res = await get("/foo");
        expect(res.status).toBe(200);
        expect(res.body).toContain("static@foo-index");
      },
    );
  });

  test("/foo/ (trailing slash) → foo/index.html", async () => {
    await withServer({ "foo/index.html": staticPage("foo-index") }, async ({ get }) => {
      const res = await get("/foo/");
      expect(res.status).toBe(200);
      expect(res.body).toContain("static@foo-index");
    });
  });

  test("HTML wins when both file.html and file.md exist", async () => {
    await withServer(
      {
        "index.html": fakeShell("root"),
        "about.html": staticPage("about"),
        "about.md": "# raw about\n",
      },
      async ({ get }) => {
        const res = await get("/about");
        expect(res.body).toContain("static@about");
        expect(res.body).not.toContain("shell@");
      },
    );
  });
});

// ===========================================================================
// (4) A route that resolves to markdown is served through the nearest ancestor
//     marked index.html shell; (5) the matching raw .md is fetchable.
// ===========================================================================
describe("(4) markdown served through the nearest ancestor shell", () => {
  test("/a/b/page → uses marked a/index.html (nearest), not the root shell", async () => {
    await withServer(
      {
        "index.html": fakeShell("root"),
        "a/index.html": fakeShell("a"),
        "a/b/page.md": "# page\n",
      },
      async ({ get }) => {
        const res = await get("/a/b/page");
        expect(res.status).toBe(200);
        expect(res.body).toContain("shell@a"); // nearest ancestor renderer
        expect(res.body).not.toContain("shell@root"); // not the root one
      },
    );
  });

  test("/a/b/page → walks all the way up to the root shell when no closer one", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "a/b/page.md": "# page\n" },
      async ({ get }) => {
        const res = await get("/a/b/page");
        expect(res.body).toContain("shell@root");
      },
    );
  });

  test("/file → file/index.md is served via the shell", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "file/index.md": "# dir index\n" },
      async ({ get }) => {
        const res = await get("/file");
        expect(res.status).toBe(200);
        expect(res.body).toContain("shell@root");
      },
    );
  });

  test("(5) the route serves a shell AND the underlying .md is fetchable raw", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "guide.md": "# the guide\n" },
      async ({ get }) => {
        const page = await get("/guide");
        expect(page.body).toContain("shell@root"); // shell serves the route

        const md = await get("/guide.md"); // …and loads this
        expect(md.status).toBe(200);
        expect(md.body).toBe("# the guide\n"); // byte-for-byte, not wrapped
        expect(md.body).not.toContain(RELOAD);
      },
    );
  });

  test("(4) embedded shell is used when no marked index.html exists anywhere", async () => {
    await withServer({ "sub/page.md": "# orphan\n" }, async ({ get }) => {
      const res = await get("/sub/page");
      expect(res.status).toBe(200);
      expect(res.body).toContain(ENGINE); // the real renderer baked into the CLI
      expect(res.body).toContain(RELOAD); // reload client injected into it
    });
  });

  test("unmarked index.html remains static and does not become a markdown renderer", async () => {
    await withServer(
      {
        "index.html": staticPage("root"),
        "page.md": "# p\n",
      },
      async ({ get }) => {
        const res = await get("/page");
        expect(res.status).toBe(200);
        expect(res.body).toContain(ENGINE);
        expect(res.body).not.toContain("static@root");
      },
    );
  });
});

// ===========================================================================
// Resolution precedence for "/" (index.html before index.md).
// ===========================================================================
describe("root route", () => {
  test("/ → index.html is served before index.md when present", async () => {
    await withServer(
      { "index.html": staticPage("root"), "index.md": "# home\n" },
      async ({ get }) => {
        const res = await get("/");
        expect(res.status).toBe(200);
        expect(res.body).toContain("static@root");
      },
    );
  });
});

// ===========================================================================
// Raw files are served directly, untouched.
// ===========================================================================
describe("raw file serving", () => {
  test("a referenced component .js is served as-is", async () => {
    const js = "export default () => null;\n";
    await withServer({ "index.html": fakeShell("root"), "components/X.js": js }, async ({ get }) => {
      const res = await get("/components/X.js");
      expect(res.status).toBe(200);
      expect(res.type).toContain("text/javascript");
      expect(res.body).toBe(js);
    });
  });

  test("a .md fetched directly is raw markdown, not shell-wrapped", async () => {
    await withServer({ "index.html": fakeShell("root"), "about.md": "# about\n" }, async ({ get }) => {
      const res = await get("/about.md");
      expect(res.status).toBe(200);
      expect(res.body).toBe("# about\n");
      expect(res.body).not.toContain("shell@");
      expect(res.body).not.toContain(RELOAD);
    });
  });

  test("a direct .md request falls back to file/index.md raw", async () => {
    await withServer({ "index.html": fakeShell("root"), "about/index.md": "# about index\n" }, async ({ get }) => {
      const res = await get("/about.md");
      expect(res.status).toBe(200);
      expect(res.body).toBe("# about index\n");
      expect(res.body).not.toContain("shell@");
      expect(res.body).not.toContain(RELOAD);
    });
  });
});

// ===========================================================================
// Hot-reload requirement: every served HTML page gets the reload client.
// ===========================================================================
describe("hot reload", () => {
  test("the live-reload client is injected into static pages and shells", async () => {
    await withServer(
      {
        "index.html": fakeShell("root"),
        "about.html": staticPage("about"),
        "doc.md": "# d\n",
      },
      async ({ get }) => {
        expect((await get("/about")).body).toContain(RELOAD); // static page
        expect((await get("/doc")).body).toContain(RELOAD); // shell page
      },
    );
  });
});

// ===========================================================================
// Not found and path-traversal safety.
// ===========================================================================
// ===========================================================================
// `scratchwork --version` — prints the package version.
// ===========================================================================

describe("not found & safety", () => {
  test("an unknown extensionless route → 404", async () => {
    await withServer({ "index.html": fakeShell("root") }, async ({ get }) => {
      expect((await get("/nope")).status).toBe(404);
    });
  });

  test("a missing file with an extension → 404", async () => {
    await withServer({ "index.html": fakeShell("root") }, async ({ get }) => {
      expect((await get("/missing.md")).status).toBe(404);
    });
  });

  test("a path that escapes the root → 403 and leaks nothing", async () => {
    // Root is dir/site; a secret sits one level up at dir/secret.txt.
    const dir = makeFixture({
      "site/index.html": fakeShell("root"),
      "secret.txt": "TOP SECRET",
    });
    const proc = spawnServer(join(dir, "site"));
    try {
      const { port } = await waitForReady(proc);
      // %2e%2e%2f is an encoded "../" — stays encoded through fetch so the
      // server, not the URL parser, has to defend against it.
      const res = await httpGet(port, "/%2e%2e%2fsecret.txt");
      expect(res.status).toBe(403);
      expect(res.body).not.toContain("TOP SECRET");
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
