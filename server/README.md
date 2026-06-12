# Scratchwork server

The server that hosts sites published with `scratchwork publish`. One
runtime-agnostic request handler ([`src/app.js`](src/app.js)) runs in two places:

- **locally**, on Bun, backed by the filesystem — for development and self-hosting
- **in production**, on Cloudflare Workers, backed by an R2 bucket

**Zero runtime dependencies.** No framework, no database, no auth library. The
only dev dependency is `wrangler`, and only for deploying to Cloudflare.

## Run it locally

```sh
bun run start                 # serve on :8787, data in ./.scratchwork-data
bun src/local.js --port 9000 --data /tmp/sw
```

Then publish to it:

```sh
scratchwork publish ./docs --server http://localhost:8787
```

Published sites live at `http://localhost:8787/<id>/`. Auth is **off** by default
locally — set `SCRATCHWORK_TOKEN` to require a bearer token, matching production.

## Deploy to Cloudflare

One command, idempotent — run it as often as you like:

```sh
SCRATCHWORK_TOKEN=$(openssl rand -hex 24) ./deploy.sh   # first deploy: pick & save a token
./deploy.sh                                             # every deploy after that
```

[`deploy.sh`](deploy.sh) creates the R2 bucket if it's missing, deploys the
Worker (with the routes from [`wrangler.toml`](wrangler.toml)), sets the deploy
token when one is in the environment, and health-checks the result. It refuses
to deploy a server that would end up with no token.

That's the whole production footprint: a Worker and an R2 bucket. No D1, no KV,
no Durable Objects. See [`wrangler.toml`](wrangler.toml) for optional settings
(subdomain hosting, upload size cap, custom base URL).

Clients then authenticate once and publish:

```sh
scratchwork login --server https://scratchwork.dev   # paste the token
scratchwork publish ./docs --server https://scratchwork.dev
```

## How it works

`scratchwork publish` packages a directory into the exact static files a host
should serve, **baking the renderer shell into a static `.html` for every
markdown route** (see [`../cli/lib/publish-build.js`](../cli/lib/publish-build.js)).
After that step a site is plain static files, so the server is a dumb static host
— which is what guarantees a published site renders byte-for-byte like
`scratchwork dev`.

The upload is a tiny gzipped bundle (see
[`../shared/bundle.js`](../shared/bundle.js)) — no zip library on either side.

### Storage layout

Both adapters use the same keys:

```
meta/<projectId>.json          project record { id, name, liveDeployId, version, ... }
deploys/<deployId>/<path>      every uploaded file, verbatim
```

A deploy writes all files under a fresh `<deployId>`, then flips the project's
`liveDeployId` to it — so a deploy is atomic from a reader's point of view, and
re-publishing the same project (its id is remembered in `.scratchwork.json`)
keeps the same URL.

### HTTP API

| Method | Path                       | Purpose                                            |
| ------ | -------------------------- | -------------------------------------------------- |
| `POST` | `/api/deploy?name=&id=`    | Upload a gzipped bundle (bearer auth if enabled)   |
| `GET`  | `/api/whoami`              | `{ authRequired, authenticated }`                  |
| `GET`  | `/api/health`              | `{ ok: true }`                                     |
| `GET`  | `/install.sh`              | CLI installer script                               |
| `GET`  | `/<id>/...`                | Serve a published site's files                     |

### Auth

A bearer token, nothing more. Set `SCRATCHWORK_TOKEN` (comma-separated to allow
several). Omit it and the server accepts anonymous deploys — fine for a local or
trusted-network instance, not for the public internet. The CLI sends the token
it stored via `scratchwork login`, or reads `SCRATCHWORK_TOKEN` from the
environment (handy in CI).

### URLs and absolute paths

By default every project is served at a path: `<server>/<id>/`. For markdown
with relative asset references (the common case) this renders identically
everywhere. Sites that use **absolute** asset paths (`/style.css`) need to be
served at a host root — set `BASE_DOMAIN` and a `*.domain` route to also serve
each project at `<id>.domain`.

## Tests

```sh
bun test
```

Drives the real handler in-process against filesystem storage: the deploy path,
static resolution, auth, safety (path traversal, oversized/corrupt bundles), and
subdomain hosting.
