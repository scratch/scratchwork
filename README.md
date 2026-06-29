<p align="center">
  <img src="docs/scratchwork-logo.svg" alt="Scratchwork" width="480" />
</p>

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

To publish to a running Scratchwork server:

```sh
scratchwork publish [path]
```

## Local development

Use `scratchwork dev` to serve HTML and Markdown locally:

```sh
# Serve the current directory
scratchwork dev

# Serve a Markdown file
scratchwork dev page.md

# Serve an HTML file
scratchwork dev page.html
```

## Working with Markdown

Scratchwork renders Markdown with an embedded default renderer, and Markdown files can reference React components from nearby component files. See [`docs/index.md`](docs/index.md) for live examples.

To use the docs page as a starting point for your own project, run:

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

## Publishing

Run the publishing server locally:

```sh
cd server
bun install
bun run start
```

Then publish a directory or file:

```sh
scratchwork publish index.html
```

The server stores the bundle in local object storage by default, returns a random slug URL such as `/abc123defg/`, and returns a token. The CLI saves the slug and token in `.scratchwork.json` so the next `scratchwork publish` republishes the same URL. The server can also use S3 or R2; see `server/README.md`.

---

<p align="center">
  Made with <a href="https://scratchwork.dev">Scratchwork</a>
</p>
