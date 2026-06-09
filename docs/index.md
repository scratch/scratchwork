---
# Page metadata
title: "Scratchwork"                                            # Page title and og:title
description: "Share coding agent artifacts"                     # Meta description and og:description
keywords: ["MDX", "static site", "React", "Bun", "markdown"]    # Meta keywords
author: "Scratchwork"                                           # Meta author
lang: "en"                                                      # HTML lang attribute
---

<img src="/scratchwork-logo.svg" alt="Scratchwork" style="width:80%; display:block; margin:0 auto;" />

Scratchwork is a tool for sharing the static HTML and Markdown artifacts created by your coding agent.

Specifically, Scratchwork is:

1. A CLI for viewing and publishing static websites 
2. A server (hosted on Cloudflare) for sharing publicly or privately
3. A template website for authoring static content with Markdown

## Quick start

There are two ways to get started with Scratchwork. The first way is to ask your coding agent to publish an HTML or Markdown file for you:

```text
Publish myspec.md on scratchwork.dev 
```

Alternatively, you can install `scratchwork`, the Scratchwork CLI, directly:

```sh
curl -fsSL https://scratchwork.dev/install.sh | bash

scratchwork --version
```

## Publishing with Scratchwork 

You can use the `scratchwork` CLI to publish any static website:

```sh
# Publish all .html, .js, .css, .md, and image files in dir (defaults to .)
scratchwork publish [dir]

# Publish page.html
scratchwork publish page.html

# Publish page.md
scratchwork publish page.md
```


## Working with Markdown

In addition to HTML, Scratchwork supports Markdown, which is easier for humans to read and write:

```sh
# Serve myspec.md with the development server
scratchwork dev myspec.md
```

Scratchwork uses a default template html file to render Markdown content as a web page. This template allows for embedding React components right in your markdown files. This is handy for for e.g. adding interactive demos to your writing like this:

<div style="display:flex; justify-content:center;">
  <Counter />
</div>

...or building custom formatting components <Highlight>like this highlighter</Highlight>.

You can add the template directly to your project with 

```sh
# Write the default template to template.html
scratchwork eject template.html
```

To use this page as a starting point for your project, use:

```sh 
# Create a new project with example Markdown and React content
scratchwork create [path]
```

When `template.html` is present in your project root directory it overrides the default Scratchwork template, which allows you to modify the default styling for rendered Markdown files.


<MadeWithScratchwork />
