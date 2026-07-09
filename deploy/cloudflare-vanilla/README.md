# sndbx.sh Cloudflare deploy

This deploy instance is a Bun project that uses the shared Cloudflare Worker
deploy package to serve the sndbx.sh domain, without Cloudflare Access in
front of it (hence "vanilla" — compare `deploy/cf-access`).

Deploy from the repo root:

```sh
bun run deploy:cloudflare-vanilla
```

Start local secrets from the template:

```sh
cp deploy/cloudflare-vanilla/.env.example deploy/cloudflare-vanilla/.env
```

The server settings (domains, auth policy, sharing rules) live in
`server-config.ts`. `cloudflare-config.ts` adds the Worker, R2, D1, and route
configuration; both the remote deploy and local Wrangler run consume that same
complete config. Secrets are read from `.env` in this directory and the shell
environment.
It binds the Worker with routes for `app.sndbx.sh/*` (app/API/auth),
`pages.sndbx.sh/*` (published content), and the home domains `sndbx.sh/*` and
`www.sndbx.sh/*`, which serve the homepage project `www` (`homepageDomains` /
`homepageProject` in `server-config.ts`; `www.sndbx.sh` 308-redirects to
`sndbx.sh`). The Worker name is `scratchwork`, matching the existing
Cloudflare route assignment for those hostnames.

The homepage is an ordinary project: after a fresh deploy, publish it with

```sh
scratchwork publish --server https://app.sndbx.sh --project www --public
```

(the deploy output prints this command). Until then, `sndbx.sh` serves a
setup page with the same instructions. Re-publishing updates the homepage;
no redeploy needed.

Configure the Google OAuth redirect URI as:

```txt
https://app.sndbx.sh/auth/callback/google
```

## Local run

Run the sndbx.sh Worker with Wrangler's persistent local R2 and D1 bindings:

```sh
bun run local:cloudflare-vanilla   # from the repo root, or `bun run local` here
```

Because the config declares separate app and content domains, the local run
mirrors that split on one port: the app/API on `http://localhost:8787`,
published content on `http://pages.localhost:8787`, and the homepage project
on `http://home.localhost:8787` (`*.localhost` names are loopback per RFC
6761; browsers and macOS resolve them without setup). The app
stays on plain `localhost` because Google OAuth accepts it as an http redirect
URI. Set `PORT` to change the port. Wrangler stores both local R2 and D1 state
under `.scratchwork-cloudflare-data` in this directory; remove it for a clean
environment. The remote route entries are ignored by the local runtime.

The same OAuth secrets are required as for the Cloudflare deploy; Bun loads
them from `.env` in this directory. To complete a browser login locally, add
a second redirect URI to the Google OAuth client:

```txt
http://localhost:8787/auth/callback/google
```
