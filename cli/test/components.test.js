import { describe, expect, test } from "bun:test";
import { collectComponentNames } from "../../template/src/components.js";

describe("collectComponentNames", () => {
  test("ignores component-like tags inside inline code", () => {
    const md = "Each `<Tag/>` maps to a file in `components/`, then <Counter /> renders.";

    expect(collectComponentNames(md)).toEqual(["Counter"]);
  });

  test("still collects real inline and block component references", () => {
    const md = [
      "Use <Highlight>this</Highlight> inline.",
      "",
      "<Counter />",
    ].join("\n");

    expect(collectComponentNames(md)).toEqual(["Highlight", "Counter"]);
  });
});
