---
# Page metadata
title: "Scratchwork" # Page title and og:title
description: "Share your agent artifacts" # Meta description and og:description
keywords: ["MDX", "static site", "React", "Bun", "markdown"] # Meta keywords
author: "Scratchwork" # Meta author
lang: "en" # HTML lang attribute
---

<img src="/scratchwork-logo.svg" alt="Scratchwork" style="width:80%; display:block; margin:0 auto;" />

Scratchwork is a tool for sharing static websites with your colleagues.

It's designed for sharing agent artifacts like HTML and markdown files, but it's also useful for writing, product specs, mocks, and demos.

Publish your work publicly to share it with the world, or privately to share it with friends and teammates.

## Quick start

Just ask your agent:

```
Create a simple "hello world" website and publish it to
scratchwork.dev. Give everyone with an email @example.com
permission to read it.
```

## Slow start

Install the Scratchwork CLI with

```sh
curl -fsSL https://scratchwork.dev/install.sh | bash
```

Ask your agent to create an html or markdown file, or use a Scratchwork example project:

```sh
scratchwork example
```

Preview your work locally:

```sh
scratchwork dev
```

Publish it privately

```sh
scratchwork publish --server scratchwork.dev --private
```

Give your all of your teammates read access:

```sh
scratchwork share @example.com --role read
```

## Working with Markdown and React

HTML is great for reading, but it's a terrible medium for writing. Scratchwork renders Markdown with an embedded default renderer. It's not magic; you can see (and edit) it with `scratchwork template`.

Your markdown files can reference React components defined in `./components/`, which is useful for interactive demos like this:

<div style="display:flex; justify-content:center;">
  <Counter />
</div>

...or building custom formatting components <Highlight>like this highlighter</Highlight>.

## Publishing on scratchwork.dev

For now, you can publish projects (<5mb) on [scratchwork.dev](https://scratchwork.dev) for free. However, published projects are deleted after 48 hours.

If you'd like to be able to pay for a hosted option, upvote [this Github issue](https://github.com/koomen/scratchwork) (TODO: create an issue)

## Hosting your own server

Scratchwork is open source and can be hosted anywhere. To scaffold your own server project, use:

```sh
# Configure for Cloudflare (a worker using R2 and D1)
npm create scratchwork-server my-server -- --platform cloudflare
```

swap `cloudflare` for `aws` (Lambda + S3 + DynamoDB) or `local` (a single-machine Bun server). The scaffolded README covers the credentials and settings each platform needs.

Run your server locally with

```sh
cd my-server
bun install
bun run local
```

and deploy it with

```sh
bun run deploy
```

(the `local` platform runs locally only, so it has no deploy step).

<MadeWithScratchwork />
