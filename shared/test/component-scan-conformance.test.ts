/*
 * Conformance test for the one sanctioned duplication (AGENTS.md, invariant 2):
 * renderer/src/components.js deliberately duplicates the component-scan logic
 * in shared/src/site/components.ts, because the renderer is standalone browser
 * JS while the CLI dev diagnostics must predict what the renderer's loader
 * will do. This suite runs both implementations over adversarial markdown and
 * fails on any disagreement — the duplication is permitted only while this
 * test proves the copies agree.
 */
import { describe, expect, test } from "bun:test";
// eslint-disable-next-line import/extensions — the renderer ships plain .js
import { collectComponentNames as rendererScan } from "../../renderer/src/components.js";
import { collectComponentNames as sharedScan } from "../src/site/components";

/** Adversarial markdown samples: `expected` documents the agreed behavior. */
const SAMPLES: ReadonlyArray<{ name: string; text: string; expected: readonly string[] }> = [
  { name: "plain component", text: "<Card />", expected: ["Card"] },
  { name: "lowercase html is not a component", text: "<div><span attr='x'></div>", expected: [] },
  {
    name: "attributes continuing on the next line",
    text: "<Card\n  title='hi'\n/>",
    expected: ["Card"],
  },
  { name: "dotted, hyphenated, and numbered names", text: "<Foo.Bar/> <My-Comp> <C1_x >", expected: ["Foo.Bar", "My-Comp", "C1_x"] },
  { name: "name at end of line", text: "before <Card", expected: ["Card"] },
  { name: "fenced code is skipped", text: "```\n<Fake />\n```\n<Real />", expected: ["Real"] },
  { name: "tilde fences are skipped", text: "~~~\n<Fake />\n~~~", expected: [] },
  { name: "fence with info string", text: "```jsx\n<Fake />\n```", expected: [] },
  { name: "indented fence still toggles", text: "  ```\n<Fake />\n  ```", expected: [] },
  { name: "unclosed fence skips the rest", text: "```\n<Fake />\n<AlsoFake />", expected: [] },
  {
    name: "backticks inside a fenced block do not open inline spans",
    text: "```\n`\n```\n<Real />",
    expected: ["Real"],
  },
  { name: "inline code is skipped", text: "use `<Fake />` here, and <Real/>", expected: ["Real"] },
  {
    name: "double-backtick span containing a single backtick",
    text: "``code ` with tick <Fake/>`` <Real/>",
    expected: ["Real"],
  },
  {
    name: "span closes only on a run of exactly the opening length",
    text: "``<Fake/> ` still code ``` also closed? <Fake2/>``, and <Real/>",
    expected: ["Real"],
  },
  {
    name: "unclosed backtick run leaves the rest scannable",
    text: "`unclosed <Scanned />",
    expected: ["Scanned"],
  },
  { name: "single-line html comment is skipped", text: "<!-- <Hidden /> --> <Real/>", expected: ["Real"] },
  {
    name: "multi-line html comment is NOT skipped (documented single-line rule)",
    text: "<!--\n<Visible />\n-->",
    expected: ["Visible"],
  },
  { name: "two comments on one line", text: "<!-- <A/> --> <Real/> <!-- <B/> -->", expected: ["Real"] },
  {
    name: "table row mixing inline code and components",
    text: "| `<Fake/>` | <Real/> | ``x`` |",
    expected: ["Real"],
  },
  { name: "duplicate names collapse", text: "<Card/><Card/><Card />", expected: ["Card"] },
  { name: "tag split by inline span boundary", text: "`<Fa`ke/> <Real/>", expected: ["Real"] },
  { name: "empty document", text: "", expected: [] },
  { name: "angle bracket without a component name", text: "a < B when B is math, <1Card/>", expected: [] },
];

describe("component-scan conformance (sanctioned duplication)", () => {
  for (const sample of SAMPLES) {
    test(sample.name, () => {
      const fromShared = [...sharedScan(sample.text)].sort();
      const fromRenderer = [...rendererScan(sample.text)].sort();
      expect(fromRenderer).toEqual(fromShared);
      expect(fromShared).toEqual([...sample.expected].sort());
    });
  }

  test("agree across every prefix of a stress document", () => {
    // Slicing a document at every position exercises unterminated spans,
    // comments, and fences at each boundary; the implementations must agree
    // on all of them (expected values are whatever shared says).
    const doc = SAMPLES.map((sample) => sample.text).join("\n");
    for (let end = 0; end <= doc.length; end++) {
      const slice = doc.slice(0, end);
      expect([...rendererScan(slice)].sort()).toEqual([...sharedScan(slice)].sort());
    }
  });
});
