<p align="center">
  <img src="docs/scratchwork-logo.svg" alt="Scratchwork" width="480" />
</p>

Scratchwork is a local development tool for static HTML and Markdown artifacts created by your coding agent.

Specifically, Scratchwork is:

1. A CLI for serving static websites locally with hot reload
2. A Markdown renderer that supports React components
3. A publishing server that can run locally, on AWS, or on Cloudflare

## Quick start

Install `scratchwork`, then start the local development server:

```sh
curl -fsSL https://scratchwork.dev/install.sh | bash

scratchwork --version
scratchwork dev [path]
```

To publish to a running Scratchwork server:

```sh
scratchwork login https://your-scratchwork-server.example
scratchwork publish --workspace myspace --project myproject [path]
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
bun run server
```

Then publish a directory or file:

```sh
scratchwork login --server http://localhost:3001
scratchwork publish index.html
```

The server stores immutable file blobs in object storage and mutable project metadata in its database. The CLI saves `server`, `workspace`, `project`, `visibility`, and the latest URL in `.scratchwork.json` so the next `scratchwork publish` updates the same project.

Deploy the server with one command:

```sh
bun run deploy:aws
bun run deploy:cloudflare
```

Cloud runtime dependencies live in `server/deploy-aws` and `server/deploy-cloudflare`. See `server/README.md` for cloud setup details.

Deploy secrets can be loaded from `server/.env` or an explicit env file:

```sh
cp server/.env.example server/.env
bun run deploy:cloudflare --env server/.env
```

---

<p align="center">
  Made with <a href="https://scratchwork.dev">Scratchwork</a>
</p>
