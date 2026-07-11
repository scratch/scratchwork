# Access-protected sndbx.sh Cloudflare deploy

This deploy instance is a Bun project that uses the shared Cloudflare Worker
deploy package to serve a Scratchwork server behind [Cloudflare
Access](https://developers.cloudflare.com/cloudflare-one/policies/access/),
which authenticates users at the edge instead of the server running OAuth
itself (compare `deploy/cloudflare-vanilla`).

It binds the Worker `scratchwork-access` with routes for `access.sndbx.sh/*`
(app/API/auth) and `access-pages.sndbx.sh/*` (published content). Everything
is private (`allowPublicProjects: false`): Access blocks anonymous visitors at
the edge, so a public project could never be reached anyway.

## Access application setup (once)

In the Cloudflare Zero Trust dashboard, create a self-hosted Access
application that covers **both** hostnames, `access.sndbx.sh` and
`access-pages.sndbx.sh`, with a policy allowing the intended users. Then:

- Copy the application's Audience (AUD) tag from its overview page into
  `SCRATCHWORK_CF_ACCESS_AUD`.
- Copy the team domain into `SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN`.
- Set a long session duration on the application: `scratchwork login` relays
  the browser's Access JWT to the CLI, and CLI commands start failing with a
  re-login prompt when it expires.

`SCRATCHWORK_ALLOWED_USERS` still applies on top of the Access policy; this
config leaves it at `public`, so the Access policy alone decides who gets in.
See the "Cloudflare Access" section of `server/README.md` for CLI behavior,
service tokens for CI, and older-CLI fallbacks.

## Deploy

Start local secrets from the template, then deploy from the repo root:

```sh
cp deploy/cloudflare-access/.env.example deploy/cloudflare-access/.env
bun run deploy:cloudflare-access
```

The server settings (domains, auth mode, sharing rules) live in
`server-config.ts`. `cloudflare-config.ts` adds the Worker, R2, D1, and route
configuration; both the remote deploy and local Wrangler run consume that same
complete config. Secrets are read from `.env` in this directory and the shell
environment.

## Local run

Run the same Worker with Wrangler's persistent local R2 and D1 bindings and a
simulated Access edge — no `.env`, Cloudflare account, or Access application
needed:

```sh
bun run local:cloudflare-access   # from the repo root, or `bun run local` here
```

It listens on `http://localhost:8787` (set `PORT` to change) and signs Access
assertions for `developer@example.com`. Select another identity with:

```sh
SCRATCHWORK_LOCAL_CF_ACCESS_EMAIL=alice@example.com bun run local:cloudflare-access
```

Because the config declares separate app and content domains, the local run
mirrors that split on one port: the app/API on `http://localhost:8787` and
published content on `http://pages.localhost:8787` (`*.localhost` names
are loopback per RFC 6761; browsers and macOS resolve them without setup).

Wrangler stores both local R2 and D1 state under
`.scratchwork-cloudflare-data` in this directory; remove that ignored
directory for an empty environment. The remote route entries are ignored by
the local runtime. This simulates an already-authenticated Access session and
its signed identity assertion, not the Cloudflare policy engine or an identity
provider's login UI.
