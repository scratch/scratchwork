import { describe, expect, test } from "bun:test";
import {
  parseFrontmatter,
  parseBlocks,
  parseJSXAttrs,
  scanElement,
  splitTableRow,
  collectLinkDefs,
  slugify,
  plainText,
  dedent,
} from "../src/parser.js";

describe("parseFrontmatter", () => {
  test("parses quoted values, comments, and flow arrays", () => {
    const { meta, body } = parseFrontmatter(
      '---\ntitle: "Scratchwork"   # comment\nkeywords: ["a", "b"]\nplain: hello # trailing\nquoted_hash: "C# guide"\n---\nbody',
    );
    expect(meta.title).toBe("Scratchwork");
    expect(meta.keywords).toBe("a, b");
    expect(meta.plain).toBe("hello");
    expect(meta.quoted_hash).toBe("C# guide");
    expect(body).toBe("body");
  });

  test("no frontmatter returns the input unchanged", () => {
    expect(parseFrontmatter("# hi").body).toBe("# hi");
    expect(parseFrontmatter("# hi").meta).toEqual({});
  });

  test("text after a closing quote that isn't a comment keeps the raw value", () => {
    const { meta } = parseFrontmatter('---\nsubtitle: "Q3" review notes\n---\nx');
    expect(meta.subtitle).toBe('"Q3" review notes');
  });
});

describe("parseBlocks: structure", () => {
  const types = (md) => parseBlocks(md).map((b) => b.type);

  test("headings, paragraphs, code, hr, blockquote, table", () => {
    expect(types("# h\n\ntext\n\n```\nc\n```\n\n---\n\n> q")).toEqual([
      "heading", "p", "code", "hr", "blockquote",
    ]);
    expect(types("| a |\n|---|\n| 1 |")).toEqual(["table"]);
  });

  test("setext headings", () => {
    const blocks = parseBlocks("Title One\n=========\n\nTitle Two\n---");
    expect(blocks).toEqual([
      { type: "heading", level: 1, text: "Title One" },
      { type: "heading", level: 2, text: "Title Two" },
    ]);
  });

  test("hr variants", () => {
    expect(types("----\n\n*****\n\n- - -\n\n_ _ _")).toEqual(["hr", "hr", "hr", "hr"]);
  });

  test("a paragraph cannot swallow a following table, hr, or list", () => {
    expect(types("text\n| a |\n|---|\n| 1 |")).toEqual(["p", "table"]);
    expect(types("text\n- item")).toEqual(["p", "ul"]);
    expect(types("text\n***")).toEqual(["p", "hr"]);
  });

  test("a dash line under prose with a pipe is not a table (column counts must match)", () => {
    // (the lone dash is a setext underline, so the prose becomes an h2 — not a table)
    expect(types("Options -a | -b\n-\nmore text")).toEqual(["heading", "p"]);
    expect(types("| a | b |\n|---|\n| 1 |")).not.toContain("table");
  });

  test("ordered list at 2 does not interrupt a paragraph (GFM)", () => {
    expect(types("I bought\n2. apples")).toEqual(["p"]);
  });

  test("html comments are dropped, even multi-line", () => {
    expect(types("a\n\n<!-- x -->\n\nb")).toEqual(["p", "p"]);
    expect(types("a\n\n<!-- one\ntwo -->\n\nb")).toEqual(["p", "p"]);
  });

  test("unbalanced tags never hang and keep their text", () => {
    expect(parseBlocks("<br>")).toEqual([{ type: "jsx", src: "<br>" }]);
    const blocks = parseBlocks("<div>\nnever closed");
    expect(blocks[0].type).toBe("p");
  });

  test("an inline element with trailing text stays a paragraph", () => {
    expect(parseBlocks("<em>Hi</em> everyone")).toEqual([
      { type: "p", text: "<em>Hi</em> everyone" },
    ]);
  });

  test("fence info strings keep only the language; tilde fences work", () => {
    expect(parseBlocks('```js title="x" {1}\ncode\n```')[0].lang).toBe("js");
    expect(parseBlocks("~~~python\ncode\n~~~")[0]).toMatchObject({ type: "code", lang: "python" });
  });

  test("longer fences may contain shorter ones", () => {
    const block = parseBlocks("````\n```\ninner\n```\n````")[0];
    expect(block.code).toBe("```\ninner\n```");
  });

  test("indented code blocks", () => {
    const blocks = parseBlocks("para:\n\n    const x = 1;\n    log(x);\n\ndone");
    expect(blocks.map((b) => b.type)).toEqual(["p", "code", "p"]);
    expect(blocks[1].code).toBe("const x = 1;\nlog(x);");
  });

  test("blockquote lazy continuation", () => {
    expect(parseBlocks("> quote\nlazy line")).toEqual([
      { type: "blockquote", text: "quote\nlazy line" },
    ]);
  });

  test("reference-link definitions become invisible linkdef blocks", () => {
    const blocks = parseBlocks("[Ref]: https://x.com\n\ntext");
    expect(blocks.map((b) => b.type)).toEqual(["linkdef", "p"]);
    expect(blocks[0]).toMatchObject({ ref: "ref", href: "https://x.com" });
    expect(parseBlocks("  [indented]: https://x.com")[0].type).toBe("linkdef");
  });
});

describe("parseBlocks: lists", () => {
  test("nested lists become children of the previous item", () => {
    const [ul] = parseBlocks("- a\n  - a1\n  - a2\n- b");
    expect(ul.items.map((i) => i.text)).toEqual(["a", "b"]);
    expect(ul.items[0].children[0].items.map((i) => i.text)).toEqual(["a1", "a2"]);
  });

  test("ordered lists keep their start number and 1) markers work", () => {
    expect(parseBlocks("3. three\n4. four")[0]).toMatchObject({ type: "ol", start: 3 });
    expect(parseBlocks("1) one")[0].type).toBe("ol");
    expect(parseBlocks("1. one")[0].start).toBeUndefined();
  });

  test("task list items carry checked state with the marker stripped", () => {
    const [ul] = parseBlocks("- [ ] todo\n- [x] done\n- plain");
    expect(ul.items.map((i) => i.checked)).toEqual([false, true, undefined]);
    expect(ul.items.map((i) => i.text)).toEqual(["todo", "done", "plain"]);
  });

  test("blank lines between items keep one list", () => {
    expect(parseBlocks("- one\n\n- two")).toHaveLength(1);
  });

  test("indented and lazy continuation lines join the item", () => {
    const [ul] = parseBlocks("- first\n  indented more\nlazy more\n- second");
    expect(ul.items[0].text).toBe("first\nindented more\nlazy more");
    expect(ul.items[1].text).toBe("second");
  });

  test("fenced code inside a list item", () => {
    const [ul] = parseBlocks("- item\n  ```js\n  const x = 1;\n  ```\n- next");
    expect(ul.items).toHaveLength(2);
    expect(ul.items[0].children[0]).toMatchObject({ type: "code", lang: "js", code: "const x = 1;" });
  });

  test("tilde and long fences inside list items use the same fence rules", () => {
    const [ul] = parseBlocks("- item\n  ~~~python\n  x = ~1\n  ~~~");
    expect(ul.items[0].children[0]).toMatchObject({ type: "code", lang: "python", code: "x = ~1" });
    const [ul2] = parseBlocks("- item\n  ````js\n  x\n  ````");
    expect(ul2.items[0].children[0]).toMatchObject({ type: "code", lang: "js" });
  });

  test("continuation after a nested list stays in written order", () => {
    const [ul] = parseBlocks("- item\n  - nested\n\n  more text");
    expect(ul.items[0].text).toBe("item");
    expect(ul.items[0].children.map((c) => c.type)).toEqual(["ul", "p"]);
  });

  test("empty task items still get a checkbox", () => {
    const [ul] = parseBlocks("- [ ]\n- [x] done");
    expect(ul.items[0]).toMatchObject({ checked: false, text: "" });
  });

  test("mixed marker types split into separate lists", () => {
    expect(parseBlocks("- bullet\n1. number").map((b) => b.type)).toEqual(["ul", "ol"]);
  });
});

describe("scanElement / parseJSXAttrs", () => {
  test("void tags parse as self-closing without a slash", () => {
    expect(scanElement("<br>", 0)).toMatchObject({ name: "br", selfClosing: true });
    expect(scanElement('<img src="x.png">', 0)).toMatchObject({ name: "img", selfClosing: true });
  });

  test("braced attr values may contain >", () => {
    const node = scanElement("<Box label={a > b}>hi</Box>", 0);
    expect(node.inner).toBe("hi");
    expect(parseJSXAttrs(node.attrs)).toEqual({ label: "a > b" });
  });

  test("nested same-name tags stay balanced", () => {
    const node = scanElement("<div><div>in</div></div>", 0);
    expect(node.inner).toBe("<div>in</div>");
  });

  test("attribute forms: quoted, braced, bare boolean", () => {
    expect(parseJSXAttrs('a="1" b=\'2\' c={three} d')).toEqual({ a: "1", b: "2", c: "three", d: true });
  });
});

describe("tables", () => {
  test("splitTableRow respects escaped pipes and code spans", () => {
    expect(splitTableRow("| a\\|b | `c|d` |")).toEqual(["a|b", "`c|d`"]);
    expect(splitTableRow("| ``a|b`` | c |")).toEqual(["``a|b``", "c"]);
  });
});

describe("text helpers", () => {
  test("slugify strips markdown and links", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("See [docs](https://x.com/docs)")).toBe("see-docs");
    expect(slugify("The `run` command")).toBe("the-run-command");
  });

  test("plainText keeps link labels", () => {
    expect(plainText("**a** [b](u) ![c](i)")).toBe("a b c");
  });

  test("dedent strips the common indent", () => {
    expect(dedent("  a\n    b\n\n  c")).toBe("a\n  b\n\nc");
  });
});

describe("collectLinkDefs", () => {
  test("collects definitions from parsed blocks, case-insensitive, code excluded", () => {
    const defs = collectLinkDefs(parseBlocks('[Spec]: https://x.com "T"\n\n```\n[no]: https://no.com\n```'));
    expect(defs.spec).toEqual({ href: "https://x.com", title: "T" });
    expect(defs.no).toBeUndefined();
  });

  test("fence-nested samples can't hijack definitions (parser-accurate skipping)", () => {
    // The ``` line inside the ```` fence is content, not a fence boundary.
    const md = "````\n```\n[a]: https://code-sample.example\n````\n\n[a]: https://real.example";
    expect(collectLinkDefs(parseBlocks(md)).a.href).toBe("https://real.example");
  });
});
