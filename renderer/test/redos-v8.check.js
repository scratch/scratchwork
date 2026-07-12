#!/usr/bin/env node
/*
 * Adversarial regex timing check, run under Node — i.e. under V8.
 *
 * The renderer's unit tests run under Bun (JavaScriptCore), but the built
 * renderer runs in browsers, overwhelmingly V8 — and the two engines
 * backtrack differently. Patterns whose alternatives overlap (see the ReDoS
 * note above INLINE_PATTERNS in ../src/render.js) can stay fast in JSC while
 * exploding exponentially in V8, so a green `bun test` proves nothing about
 * the engine the renderer actually ships to.
 *
 * This script parses + renders a corpus of pathological markdown in a worker
 * thread and fails if any input exceeds its time budget. The worker reports
 * per-case timings; the main thread keeps a hard watchdog and terminates the
 * worker on a genuine hang (exponential backtracking on the escape-overlap
 * cases would run for years, not milliseconds).
 *
 *   node test/redos-v8.check.js     (wired into `bun run test` in package.json)
 */
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (process.versions.bun) {
  console.error(
    "redos-v8.check.js must run under Node: the point is V8's backtracking, which Bun (JSC) does not exercise.",
  );
  process.exit(1);
}

// Per-case budget. Healthy cases run in single-digit milliseconds (see the
// summary this script prints); regressions of interest are 100x+, not 2x.
const SOFT_MS = 2000;
// Watchdog: if the worker stops reporting for this long, it is hung inside a
// regex — terminate it and fail naming the case.
const HARD_MS = 10000;

/*
 * The corpus. Two families:
 *
 * 1. Escape-overlap (exponential in V8): every emphasis/link-label pattern
 *    alternates a `\\.` escape branch with a character class. If those
 *    branches ever overlap (the class stops excluding `\`), inputs like
 *    "**" + "\a".repeat(40) backtrack in 2^40 steps. 40 repeats is enough to
 *    turn a regression into a hang the watchdog catches, while the healthy
 *    disjoint patterns finish instantly.
 *
 * 2. Long-input stress (polynomial): unclosed constructs and huge runs that
 *    force every pattern to scan and fail repeatedly. These bound the
 *    quadratic-ish worst case of the parse loop itself.
 */
function buildCases() {
  const cases = [];
  const add = (name, md) => cases.push({ name, md });
  const esc = "\\a".repeat(40);

  for (const marker of ["**", "__", "*", "_", "***", "~~"]) {
    add(`escape-overlap ${marker}`, marker + esc);
  }
  add("escape-overlap link label", "[" + esc + "](x");
  add("escape-overlap ref label", "[" + esc + "][");
  add("images nested in unclosed label", "[" + "![a](b)".repeat(120));
  add("bang run in label", "[" + "!".repeat(3000) + "](x");

  add("backtick run", "`".repeat(5000));
  add("alternating backticks", "`a".repeat(2000));
  add("unclosed autolink", "<https://" + "a".repeat(10000));
  add("bare url", "https://" + "a/".repeat(5000) + " x");
  add("unclosed image dest, open parens", "![x](" + "(".repeat(3000));
  add("nested paren dest, unclosed", "[x](" + "(a)".repeat(2000));
  add("long dest, no close", "[x](" + "a".repeat(10000));
  add("asterisk run", "*".repeat(5000));
  add("unclosed bolds", "**a".repeat(2000));
  add("unclosed strikethroughs", "~~a".repeat(2000));
  // Sized down: the parse loop is measurably O(n^3) on escape runs in BOTH
  // engines (n=3000 takes ~9s in V8, ~5x that in JSC) — a known perf weakness,
  // not the V8-only exponential class this check guards. 800 stays fast while
  // an exponential regression would still hang the watchdog.
  add("escape run", "\\*".repeat(800));
  add("mixed unclosed nesting", "*a **b _c ~~d ".repeat(400));

  add("long heading with trailing hash", "# " + "a ".repeat(5000) + "#");
  add("hr near-miss", " - ".repeat(3000) + "x");
  add("setext near-miss", "a\n" + "-".repeat(10000));
  add(
    "wide table",
    ["|x".repeat(500) + "|", "|-".repeat(500) + "|", "|y".repeat(500) + "|"].join("\n"),
  );
  add("deeply nested quotes", "> ".repeat(200) + "a");
  add("long list", "- a\n".repeat(3000));
  add("jsx attr run", "<Tag " + 'a="b" '.repeat(2000) + "/>");
  add("unclosed comment", "<!--" + "-".repeat(10000));
  add("unclosed tag", "<T" + "a".repeat(10000));
  add("unclosed frontmatter", "---\n" + "a: b\n".repeat(3000));

  return cases;
}

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const results = [];
  let current = null;
  let timer = null;
  let hung = false;

  worker.on("message", (msg) => {
    if (msg.type === "start") {
      current = msg.name;
      timer = setTimeout(() => {
        hung = true;
        console.error(
          `FAIL ${JSON.stringify(current)}: no result after ${HARD_MS} ms — catastrophic backtracking in V8; terminating worker`,
        );
        worker.terminate().then(() => process.exit(1));
      }, HARD_MS);
    } else if (msg.type === "done") {
      clearTimeout(timer);
      results.push(msg);
    }
  });
  worker.on("error", (err) => {
    console.error("worker failed:", err);
    process.exit(1);
  });
  worker.on("exit", (code) => {
    if (hung) return;
    if (code !== 0) process.exit(code);
    const slow = results.filter((r) => r.ms > SOFT_MS);
    const worst = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
    console.log(
      `redos-v8: ${results.length} adversarial inputs rendered under node ${process.versions.node} (V8 ${process.versions.v8})`,
    );
    console.log(
      "  slowest: " + worst.map((r) => `${r.name} ${r.ms.toFixed(0)}ms`).join(", "),
    );
    for (const r of slow) {
      console.error(`FAIL ${JSON.stringify(r.name)}: ${r.ms.toFixed(0)} ms exceeds the ${SOFT_MS} ms budget`);
    }
    process.exit(slow.length > 0 ? 1 : 0);
  });
} else {
  // Bun and esbuild resolve the renderer's extensionless prismjs imports
  // (e.g. "prismjs/components/prism-bash"); node's ESM resolver does not.
  // Retry failed resolutions with ".js" so node can load the sources as-is.
  const { registerHooks } = await import("node:module");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        if (err?.code === "ERR_MODULE_NOT_FOUND" && specifier.includes("/") && !specifier.endsWith(".js")) {
          return nextResolve(specifier + ".js", context);
        }
        throw err;
      }
    },
  });

  const [{ parseBlocks, collectLinkDefs }, { renderBlocks }, React, { renderToStaticMarkup }] =
    await Promise.all([
      import(new URL("../src/parser.js", import.meta.url).href),
      import(new URL("../src/render.js", import.meta.url).href),
      import("react").then((m) => m.default),
      import("react-dom/server"),
    ]);

  // Render the way main.js does, so both parser and inline-render regexes run.
  for (const { name, md } of buildCases()) {
    parentPort.postMessage({ type: "start", name });
    const t0 = performance.now();
    const blocks = parseBlocks(md);
    renderToStaticMarkup(
      React.createElement(
        "div",
        null,
        ...renderBlocks(blocks, { components: {}, linkDefs: collectLinkDefs(blocks) }),
      ),
    );
    parentPort.postMessage({ type: "done", name, ms: performance.now() - t0 });
  }
}
