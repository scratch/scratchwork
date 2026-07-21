# scratchwork.dev Cloudflare deploy

This deploy instance is a Bun project that uses the shared Cloudflare Worker
deploy package to serve the scratchwork.dev domain — the public Scratchwork
server. Its sibling `../www/` is the homepage project published to it.

Deploy from the repo root:

```sh
bun run deploy:scratchwork-dev
```

Start local secrets from the template:

```sh
cp scratchwork.dev/server/.env.example scratchwork.dev/server/.env
```

The server settings (domains, auth policy, sharing rules) live in
`server-config.ts`. `cloudflare-config.ts` adds the Worker, R2, D1, and route
configuration; both the remote deploy and local Wrangler run consume that same
complete config. Secrets are read from `.env` in this directory and the shell
environment.

It binds the Worker (`scratchwork-dev`) with routes for
`app.scratchwork.dev/*` (app/API/auth), `pages.scratchwork.dev/*` (published
content), and the home domains `scratchwork.dev/*` and
`www.scratchwork.dev/*`, which serve the homepage project `www`
(`homepageDomains` / `homepageProject` in `server-config.ts`;
`www.scratchwork.dev` 308-redirects to `scratchwork.dev`).

The homepage is an ordinary project — the content lives in `../www/` and is
published after a deploy (and after each release, see `RELEASING.md`) with

```sh
scratchwork publish scratchwork.dev/www --server https://app.scratchwork.dev --project www --public
```

Re-publishing updates the homepage; no redeploy needed.

Configure the Google OAuth redirect URI as:

```txt
https://app.scratchwork.dev/auth/callback/google
```

## Local run

Run the scratchwork.dev Worker with Wrangler's persistent local R2 and D1
bindings:

```sh
bun run local:scratchwork-dev   # from the repo root, or `bun run local` here
```

Because the config declares separate app and content domains, the local run
mirrors that split on one port: the app/API on `http://localhost:8787`,
published content on `http://pages.localhost:8787`, and the homepage project
on `http://home.localhost:8787` (`*.localhost` names are loopback per RFC
6761; browsers and macOS resolve them without setup). The app stays on plain
`localhost` because Google OAuth accepts it as an http redirect URI. Set
`PORT` to change the port. Wrangler stores both local R2 and D1 state under
`.scratchwork-cloudflare-data` in this directory; remove it for a clean
environment. The remote route entries are ignored by the local runtime.

The same OAuth secrets are required as for the Cloudflare deploy; Bun loads
them from `.env` in this directory. To complete a browser login locally, add
a second redirect URI to the Google OAuth client:

```txt
http://localhost:8787/auth/callback/google
```
