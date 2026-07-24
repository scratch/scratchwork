<p align="center">
  <img src="scratchwork.dev/www/scratchwork-logo.svg" alt="Scratchwork" width="480" />
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
scratchwork publish [path]
scratchwork publish --project myproject [path]
```

Project names are globally unique on a server. The name defaults to the directory name (or the file name without its extension); pass `--project` to choose one. Servers configured to assign random names return the name on first publish.

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

When developing the CLI itself, activate this checkout once in each terminal
session:

```sh
source ./cli/activate-scratchwork-alias
```

After that, `scratchwork` runs `cli/src/index.ts` from this checkout, even after
changing to another directory.

## Working with Markdown

Scratchwork renders Markdown with an embedded default renderer, and Markdown files can reference React components from nearby component files. See [`scratchwork.dev/www/index.md`](scratchwork.dev/www/index.md) for live examples.

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
bun run local:local-dev
```

To run the actual Cloudflare Worker with persistent local R2 and D1 simulations (and
an optional locally signed Cloudflare Access identity), see
[`server/deploy-cloudflare/README.md`](server/deploy-cloudflare/README.md).

The ready-made Access test deployment is `bun run local:cloudflare-access`; the sndbx.sh
project's production Worker configuration runs locally with `bun run local:cloudflare-vanilla`.

Then publish a directory or file:

```sh
scratchwork login --server http://localhost:43118
scratchwork publish index.html
```

The server stores immutable file blobs in object storage and mutable project metadata in its database. The CLI saves `server`, `project`, `isPublic`, and the latest URL in `.scratchwork.json` so the next `scratchwork publish` updates the same project.

Share a published project with specific accounts or a whole domain — as readers, writers (can publish updates), or admins (can also manage sharing) — or take access away again:

```sh
scratchwork share alice@example.com @example.com
scratchwork share --role write bob@example.com
scratchwork revoke alice@example.com
```

## Connect from Claude Code (MCP)

Every Scratchwork server is also a remote [MCP](https://modelcontextprotocol.io) server, so agents can publish and manage projects with no CLI installed. In Claude Code:

```sh
claude mcp add --transport http scratchwork https://app.your-domain.example/mcp
```

Then run `/mcp` inside Claude Code to authenticate — a browser opens, you sign in with the server's regular login, approve the connection, and the agent gets `publish`, `list_projects`, `project_info`, `share_project`, `unpublish_project`, `delete_project`, and `whoami` tools. The publish tool takes file contents directly (the agent reads your local files), and responses carry the live URL.

The endpoint speaks stateless streamable HTTP with MCP-spec OAuth 2.1 (discovery, dynamic client registration, PKCE), so any conforming MCP client works the same way. If you are already logged in with the CLI, the stored bearer token from `~/.scratchwork/auth.json` also works: `claude mcp add --transport http scratchwork <server>/mcp --header "Authorization: Bearer <token>"`.

Deployments live as projects under `deploy/`, one per domain, each deployable with one command:

```sh
bun run deploy:cloudflare-vanilla
```

Cloud runtime dependencies live in `server/deploy-aws` and `server/deploy-cloudflare`. See `server/README.md` for cloud setup details.

Deploy secrets load from the project's `.env`:

```sh
cp deploy/cloudflare-vanilla/.env.example deploy/cloudflare-vanilla/.env
bun run deploy:cloudflare-vanilla
```

---

<p align="center">
  Made with <a href="https://scratchwork.dev">Scratchwork</a>
</p>
