import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseBlocks, collectLinkDefs } from "../src/parser.js";
import { renderBlocks } from "../src/render.js";

// Render markdown to an HTML string the way main.js does, with a fixed
// baseUrl so relative-src resolution is observable.
const render = (md, ctx = {}) => {
  const blocks = parseBlocks(md);
  return renderToStaticMarkup(
    React.createElement(
      "div",
      null,
      ...renderBlocks(blocks, {
        components: {},
        baseUrl: "https://site.test/docs/",
        linkDefs: collectLinkDefs(blocks),
        ...ctx,
      }),
    ),
  );
};

describe("inline markdown", () => {
  test("emphasis, code, strikethrough", () => {
    expect(render("*em* **strong** `code` ~~gone~~")).toContain(
      "<em>em</em> <strong>strong</strong> <code>code</code> <del>gone</del>",
    );
    expect(render("__strong__ _em_")).toContain("<strong>strong</strong> <em>em</em>");
  });

  test("nested emphasis", () => {
    expect(render("**bold *nested* rest**")).toContain("<strong>bold <em>nested</em> rest</strong>");
    expect(render("*a **b** c*")).toContain("<em>a <strong>b</strong> c</em>");
    expect(render("***both***")).toContain("<strong><em>both</em></strong>");
  });

  test("mid-word underscores and asterisks stay literal", () => {
    const html = render("snake_case_name and a*b*c");
    expect(html).toContain("snake_case_name");
    expect(html).toContain("a*b*c");
    expect(html).not.toContain("<em>");
  });

  test("backslash escapes suppress formatting and hide the backslash", () => {
    expect(render("\\*not em\\*")).toContain("*not em*");
    expect(render("\\*not em\\*")).not.toContain("<em>");
    expect(render("\\`not code\\`")).not.toContain("<code>");
  });

  test("multi-backtick code spans", () => {
    expect(render("``a ` b``")).toContain("<code>a ` b</code>");
    expect(render("`**not bold**`")).toContain("<code>**not bold**</code>");
  });

  test("links: inline, autolink, email, bare URL", () => {
    expect(render("[text](https://a.com)")).toContain(
      '<a href="https://a.com" target="_blank" rel="noopener noreferrer">text</a>',
    );
    expect(render("[guide](guide.md)")).toContain('<a href="guide.md">guide</a>');
    expect(render("<https://example.com>")).toContain('<a href="https://example.com"');
    expect(render("<pete@ycombinator.com>")).toContain('href="mailto:pete@ycombinator.com"');
    expect(render("see https://example.com/x now")).toContain('<a href="https://example.com/x"');
  });

  test("bare URL leaves trailing punctuation outside the link", () => {
    expect(render("Visit https://example.com.")).toContain('href="https://example.com"');
    expect(render("Visit https://example.com.")).not.toContain('href="https://example.com."');
  });

  test("URLs with parentheses survive", () => {
    expect(render("[w](https://en.wikipedia.org/wiki/Bracket_(disambiguation))")).toContain(
      'href="https://en.wikipedia.org/wiki/Bracket_(disambiguation)"',
    );
  });

  test("badge pattern: image inside a link", () => {
    const html = render('[![CI](https://img.shields.io/b.svg "Build status")](https://ci.example.com)');
    expect(html).toContain('<a href="https://ci.example.com"');
    expect(html).toContain('<img src="https://img.shields.io/b.svg" alt="CI" title="Build status"');
  });

  test("reference links resolve; unknown refs stay literal", () => {
    const md = "See [the spec][spec] and [spec] but not [nope].\n\n[spec]: https://spec.example.com";
    const html = render(md);
    expect(html).toContain('<a href="https://spec.example.com"');
    expect(html).toContain(">the spec</a>");
    expect(html).toContain("[nope]");
  });

  test("reference images render as <img>", () => {
    const html = render("![logo][img]\n\n[img]: https://x.example/logo.png");
    expect(html).toContain('<img src="https://x.example/logo.png" alt="logo"');
    expect(html).not.toContain("!<a");
  });

  test("bracketed prose without a definition still parses inner markdown", () => {
    const html = render("Status: [**done**] and [TODO: fix *this*]");
    expect(html).toContain("[<strong>done</strong>]");
    expect(html).toContain("[TODO: fix <em>this</em>]");
  });

  test("a link label may contain an inline image", () => {
    const html = render("[text with ![i](pic.png) inside](https://y.example)");
    expect(html).toContain('<a href="https://y.example"');
    expect(html).toContain('<img src="https://site.test/docs/pic.png" alt="i"');
    expect(html).toContain(" inside</a>");
  });

  test("emphasis tolerates backslash-heavy content without hanging", () => {
    expect(render("**a\\*b c**")).toContain("<strong>a*b c</strong>");
    const html = render("*" + "\\x".repeat(60) + " unclosed");
    expect(html).toContain("unclosed");
  });

  test("inline html comments render nothing", () => {
    const html = render("keep <!-- hidden --> this");
    expect(html).not.toContain("hidden");
    expect(html).toContain("keep ");
    expect(html).toContain(" this");
  });

  test("raw inline html and void tags", () => {
    expect(render("line<br>rest")).toContain("line<br/>rest");
    expect(render("a <span style=\"color:red\">red</span> word")).toContain('<span style="color:red">red</span>');
  });
});

describe("blocks", () => {
  test("paragraph hard breaks", () => {
    expect(render("one  \ntwo")).toContain("one<br/>two");
    expect(render("one\\\ntwo")).toContain("one<br/>two");
    expect(render("one\ntwo")).toContain("one two");
  });

  test("hard-break markers inside code spans don't split the span", () => {
    expect(render("run `cmd  \nflag` now")).toContain("<code>cmd   flag</code>");
  });

  test("headings get deduped ids; h2/h3 get anchors", () => {
    const html = render("# T\n\n## Setup\n\n## Setup\n\n#### Deep");
    expect(html).toContain('<h1 id="t">');
    expect(html).toContain('<h2 id="setup"');
    expect(html).toContain('<h2 id="setup-2"');
    expect(html).toContain('<h4 id="deep">');
    expect(html).toContain('href="#setup"');
  });

  test("heading ids ignore link URLs", () => {
    expect(render("## See [docs](https://x.com/docs)")).toContain('id="see-docs"');
  });

  test("nested lists render nested markup", () => {
    expect(render("- a\n  - a1\n- b")).toContain(
      "<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>",
    );
  });

  test("task lists render disabled checkboxes", () => {
    const html = render("- [x] done\n- [ ] todo");
    expect(html).toContain('class="task-list"');
    expect(html).toContain('class="task-list-item"');
    expect(html).toContain("checked");
    expect(html).toContain("disabled");
    expect(html).not.toContain("[x]");
  });

  test("ordered list start attribute", () => {
    expect(render("3. three\n4. four")).toContain('start="3"');
  });

  test("tables render alignment styles and inline markdown", () => {
    const html = render("| **h** | right |\n|:--|--:|\n| `c` | 2 |");
    expect(html).toContain("text-align:left");
    expect(html).toContain("text-align:right");
    expect(html).toContain("<strong>h</strong>");
    expect(html).toContain("<code>c</code>");
  });

  test("code blocks highlight known languages and fall back plain", () => {
    const html = render("```js\nconst a = 1;\n```");
    expect(html).toContain("scratchwork-codeblock");
    expect(html).toContain("language-javascript");
    expect(html).toContain("token");
    expect(render("```nosuchlang\nzz\n```")).toContain('language-nosuchlang">zz');
  });

  test("blockquotes re-parse their content as blocks", () => {
    const html = render("> ## Quoted heading\n> body");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("Quoted heading");
  });
});

describe("elements and components", () => {
  test("missing components render a placeholder", () => {
    expect(render("<Widget />")).toContain("scratchwork-missing");
  });

  test("components receive attrs and children", () => {
    const Box = ({ label, children }) => React.createElement("div", { "data-label": label }, children);
    const html = render('<Box label="x">**inner**</Box>', { components: { Box } });
    expect(html).toContain('data-label="x"');
    expect(html).toContain("<strong>inner</strong>");
  });

  test("style strings convert to react style objects", () => {
    expect(render('<div style="color:red; font-size:2rem">Hi</div>')).toContain(
      'style="color:red;font-size:2rem"',
    );
  });

  test("multi-line element bodies re-parse as blocks", () => {
    const html = render("<div>\n\n## Inside\n\ntext\n</div>");
    expect(html).toContain("<h2");
    expect(html).toContain("Inside");
  });

  test("relative image srcs resolve against the markdown directory", () => {
    expect(render("![p](./pic.png)")).toContain('src="https://site.test/docs/pic.png"');
    expect(render('<img src="images/x.png" alt="x" />')).toContain(
      'src="https://site.test/docs/images/x.png"',
    );
    expect(render("![p](/logo.svg)")).toContain('src="/logo.svg"');
    expect(render("![p](data:image/png;base64,AA)")).toContain('src="data:image/png;base64,AA"');
  });

  test("video poster and source src resolve like img", () => {
    const html = render('<video poster="cover.png"><source src="clip.mp4" /></video>');
    expect(html).toContain('poster="https://site.test/docs/cover.png"');
    expect(html).toContain('src="https://site.test/docs/clip.mp4"');
  });

  test("trailing text after a line-leading element is kept", () => {
    expect(render("<em>Hi</em> everyone")).toContain("<em>Hi</em> everyone");
  });
});
