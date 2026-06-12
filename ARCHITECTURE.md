# Architecture

Scratchwork has four pieces:

| Piece          | Where           | What it is                                                        |
| -------------- | --------------- | ----------------------------------------------------------------- |
| **CLI**        | `cli/`          | A zero-dependency Bun binary: `dev`, `publish`, `create`, `eject`, `login` |
| **template**   | `template/`     | The single-file renderer ("shell") that renders Markdown in the browser |
| **server**     | `server/`       | A zero-dependency publishing server (Bun locally, Cloudflare Workers in prod) |
| **shared**     | `shared/`       | Tiny modules used by both CLI and server (bundle format, resolution, favicon) |

The design goal that ties them together: **a site published with
`scratchwork publish` must render byte-for-byte like `scratchwork dev`.**

## The core idea: bake the shell, serve static

`scratchwork dev` doesn't build content. It serves a markdown route (`/guide`,
where `guide.md` exists) by returning the **renderer shell** — a single
self-contained `index.html` (React + the markdown engine, all inlined). That
shell fetches `guide.md` and renders it in the browser, lazily loading any
`components/*.js` the markdown references. Content is never rebuilt.

A plain static host can't do that markdown→shell lookup. So `scratchwork publish`
does it **at publish time** instead: it walks the source directory and, for every
markdown route, bakes the same shell out to a static `.html`
([`cli/lib/publish-build.js`](cli/lib/publish-build.js)). After that step the
site is pure static files:

```
docs/                          published bundle
  index.md            ──▶        index.md          (served raw, fetched by the shell)
  guide.md            ──▶        guide.md
                                 index.html        (baked shell for the / route)
                                 guide.html        (baked shell for /guide)
  components/Counter.js ──▶      components/Counter.js
  scratchwork-logo.svg  ──▶      scratchwork-logo.svg
```

Now the server is a **dumb static host**. Both `scratchwork dev` and the server
resolve a request the same way (`shared/resolve.js`) and serve the same shell +
the same `.md` + the same components — so the browser renders an identical page.
The only difference is that dev injects a hot-reload `<script>`; nothing else.

This is the opposite of the legacy approach (rebuild content → HTML on every
change, with base-path rewriting plugins). Building the *renderer* once and
shipping content as-is means there's nothing to keep in sync, and "renders
identically" is a property you get for free instead of a thing you chase.

### Why relative asset paths

A published project is served at `<server>/<id>/`, not at the host root. So
content should reference assets **relatively** (`scratchwork-logo.svg`, not
`/scratchwork-logo.svg`) — then the browser resolves them against the page URL
and they work at any base path, in both dev and prod. (Sites that insist on
absolute paths can be served at a host root via subdomain hosting; see the
server README.)

## The upload: a tiny gzipped bundle

No zip library on either side. `shared/bundle.js` defines a ~40-line framed
format (magic + JSON header + concatenated bytes), gzipped as a whole. The CLI
packs it; the server unpacks it. gzip collapses the per-route shell copies (they
are byte-identical) to almost nothing, so uploads stay small without de-dup
logic. Compression uses whatever the runtime provides (`Bun.gzipSync` on Bun, the
Web `CompressionStream` on Workers/Node) — the bytes are interchangeable.

## The server: one handler, two backends

[`server/src/app.js`](server/src/app.js) is a single `fetch`-style handler built
from plain `Request`/`Response` — no framework. It takes a **storage adapter**:

- `storage-fs.js` — filesystem (Bun), for local dev and self-hosting
- `storage-r2.js` — one R2 bucket (Cloudflare), for production

Both store project metadata as JSON and deploy files as blobs under the same key
layout. There is no SQL database, no auth library, no cookies. Auth, when
enabled, is a bearer token. That minimal footprint is what makes the server
"easy to deploy both locally and to Cloudflare": locally it's `bun run start`
with zero installs; in production it's one R2 bucket, one secret, `wrangler
deploy`.

## Dependency budget

- **CLI**: zero runtime dependencies (Bun built-ins + `shared/`).
- **server**: zero runtime dependencies (`wrangler` is dev-only, for deploys).
- **template**: `react`, `react-dom`, `prismjs`, `htm`, bundled once by esbuild
  into the shell.

The legacy tool pulled in `commander`, `jszip`, `hono`, `better-auth`, `jose`,
`kysely`, `unzipit`, and a full MDX/remark/rehype/shiki build pipeline. None of
that is here.
