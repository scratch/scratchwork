---
# Page metadata — edit freely.
title: "Markdown feature spectrum"
description: "A visual fixture for Scratchwork's supported Markdown"
author: "Scratchwork"
lang: "en"
keywords: ["markdown", "components", "test fixture"]
---

[![Scratchwork](scratchwork-logo.svg "Scratchwork")](https://scratchwork.dev)

# Markdown feature spectrum

This page exercises Scratchwork's supported Markdown and component embedding.
Edit `index.md` and it hot-reloads while `scratchwork dev` is running.

## React components, inline

Scratchwork maps each embedded component to a JavaScript file in `components/`.
The existing stateful counter remains part of this fixture:

<div style="display:flex; justify-content:center;">
  <Counter />
</div>

Components can also wrap Markdown content. Here is
<Highlight>text rendered by the existing Highlight component</Highlight>.

Open `components/Counter.js` and `components/Highlight.js` to see how the
components are defined.

<!-- HTML comments should not appear in the rendered page. -->

Underlined heading level one
============================

Underlined heading level two
----------------------------

### ATX heading level three

#### ATX heading level four

##### ATX heading level five

###### ATX heading level six

## Inline formatting

Plain text can contain *asterisk emphasis*, _underscore emphasis_, **bold**,
***bold italic***, ~~strikethrough~~, and `inline code`. A multi-backtick span
can contain a backtick: ``const marker = `code`;``.

Escaped punctuation stays literal: \*not italic\*, \[not a link\], and \# not a
heading. This line ends with a backslash.\
So this text starts after a hard break. This one does too.\
It also starts after a hard break.

## Links

Try an [inline link](https://scratchwork.dev "Scratchwork"), a [reference
link][scratchwork], an autolink <https://example.com>, and a bare URL:
https://example.org/docs.

## Lists

- An unordered item
- An item with lazy
  continuation text
  - A nested unordered item
  - Another nested item
- A final item

An ordered list with an explicit starting number:

3. An ordered list starting at three
4. Its second item
   1. A nested ordered item
   2. Another nested ordered item

Task list items:

- [x] Completed task
- [ ] Open task
- Plain list item

Fenced code nested inside a list:

- A list item containing fenced code:

  ```js
  const insideAList = true;
  ```

- The next list item

## Blockquotes

> A blockquote can contain **formatting** and a [link][scratchwork].
>
> > It can also contain a nested blockquote.
>
> - And a list
> - With multiple items

## Code blocks

```js
// Backtick fence with syntax highlighting.
function hello(name) {
  return `Hello, ${name}!`;
}
```

~~~python
# Tilde fences work too.
def hello(name):
    return f"Hello, {name}!"
~~~

An indented code block follows:

    const indented = "four spaces";
    console.log(indented);

## Tables

| Left aligned | Center aligned | Right aligned |
| :----------- | :------------: | ------------: |
| Alpha        | Beta           | 10            |
| Escaped \| pipe | `code | pipe` | 20         |

## Horizontal rule

Thematic sections can be separated with a horizontal rule.

---

The content continues after the rule.

## Raw HTML

Inline HTML includes <kbd>Ctrl</kbd> + <kbd>K</kbd> and an explicit<br>line
break.

<div className="markdown-fixture" style="padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 0.5rem;">
  This block is rendered from raw HTML with <strong>nested markup</strong> and
  inline styles.
</div>

[scratchwork]: https://scratchwork.dev "Scratchwork home"
