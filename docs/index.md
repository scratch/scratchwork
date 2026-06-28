---
# Page metadata
title: "Scratchwork"                                            # Page title and og:title
description: "Share coding agent artifacts"                     # Meta description and og:description
keywords: ["MDX", "static site", "React", "Bun", "markdown"]    # Meta keywords
author: "Scratchwork"                                           # Meta author
lang: "en"                                                      # HTML lang attribute
---

<img src="/scratchwork-logo.svg" alt="Scratchwork" style="width:80%; display:block; margin:0 auto;" />

Scratchwork is a local development tool for static HTML and Markdown artifacts created by your coding agent.

Specifically, Scratchwork is:

1. A CLI for serving static websites locally with hot reload
2. A Markdown renderer that supports React components
3. Shared routing/rendering logic for the future server

## Quick start

Install `scratchwork`, then start the local development server:

```sh
curl -fsSL https://scratchwork.dev/install.sh | bash

scratchwork --version
scratchwork dev [path]
```

Publishing and hosted sharing are being rebuilt.

## Local development

```sh
# Serve the current directory
scratchwork dev

# Serve a Markdown file
scratchwork dev page.md

# Serve an HTML file
scratchwork dev page.html
```

## Working with Markdown

Scratchwork renders Markdown with an embedded default renderer. Markdown files can reference React components from nearby component files, which is useful for interactive demos like this:

<div style="display:flex; justify-content:center;">
  <Counter />
</div>

...or building custom formatting components <Highlight>like this highlighter</Highlight>.

To use this page as a starting point for your project, run:

```sh
# Write example Markdown and React content
scratchwork example [path]
```

To copy the default Markdown renderer into your project, run:

```sh
# Write the default renderer to index.html
scratchwork template [file]
```

To customize Markdown rendering, add an `index.html` renderer file at or above the Markdown file and start it with Scratchwork's identifying comment:

```html
<!-- scratchwork:markdown-renderer - tells Scratchwork this index.html renders Markdown routes. -->
```

<MadeWithScratchwork />
