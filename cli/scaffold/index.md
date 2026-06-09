---
# Page metadata — edit freely.
title: "My Scratchwork project"
description: "A static page authored in Markdown"
author: "Me"
lang: "en"
---

# My Scratchwork project

Welcome! This page was scaffolded by `scratchwork create`. It's plain Markdown —
edit `index.md` and the page hot-reloads while `scratchwork dev` is running.

## Markdown, the usual way

Write **bold**, _italic_, `inline code`, [links](https://scratchwork.dev), and
lists:

- Add a list item
- Then another
- Reorder them however you like

```js
// Fenced code blocks are syntax-highlighted.
function hello(name) {
  return `Hello, ${name}!`;
}
```

## React components, inline

Scratchwork renders Markdown through a template that lets you drop React
components right into the prose. Each `<Tag/>` maps to a file in `components/`:

<div style="display:flex; justify-content:center;">
  <Counter />
</div>

You can also build small formatting components <Highlight>like this
highlighter</Highlight> for anything Markdown can't express on its own.

Open `components/Counter.js` to see how a component is defined, then add your
own.
