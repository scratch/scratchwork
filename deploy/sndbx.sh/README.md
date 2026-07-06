# sndbx.sh Cloudflare deploy

This deploy instance is a Bun project that uses the shared Cloudflare Worker
deploy package.

Deploy from the repo root:

```sh
bun run deploy:sndbx.sh
```

Start local secrets from the template:

```sh
cp deploy/sndbx.sh/.env.example deploy/sndbx.sh/.env
```

The server settings (domains, auth policy, visibility rules) live in
`server-config.ts` and are shared by the Cloudflare deploy and the local run;
`deploy.ts` adds the Cloudflare-specific bindings. Secrets are read from `.env`
in this directory and the shell environment.
It binds the Worker with routes for `app.sndbx.sh/*` (app/API/auth),
`pages.sndbx.sh/*` (published content), and the home domains `sndbx.sh/*` and
`www.sndbx.sh/*`, which serve the homepage project `www` (`homepageDomains` /
`homepageProject` in `server-config.ts`; `www.sndbx.sh` 308-redirects to
`sndbx.sh`). The Worker name is `scratchwork`, matching the existing
Cloudflare route assignment for those hostnames.

The homepage is an ordinary project: after a fresh deploy, publish it with

```sh
scratchwork publish --server https://app.sndbx.sh --project www --visibility public
```

(the deploy output prints this command). Until then, `sndbx.sh` serves a
setup page with the same instructions. Re-publishing updates the homepage;
no redeploy needed.

Configure the Google OAuth redirect URI as:

```txt
https://app.sndbx.sh/auth/callback/google
```

## Local run

Run the sndbx.sh server settings on a local server (local file storage,
in-memory database, no Cloudflare access needed):

```sh
bun run local:sndbx.sh   # from the repo root, or `bun run local` here
```

Because the config declares separate app and content domains, the local run
mirrors that split on one port: the app/API on `http://localhost:43118`,
published content on `http://pages.localhost:43118`, and the homepage project
on `http://home.localhost:43118` (`*.localhost` names are loopback per RFC
6761; browsers and macOS resolve them without setup). The app
stays on plain `localhost` because Google OAuth accepts it as an http redirect
URI. Set `PORT` to change the port, and `SCRATCHWORK_STORAGE_DIR` to relocate
storage (default `.scratchwork-local-data` in this directory). Any
`SCRATCHWORK_*` environment variable overrides the shared config.

The same OAuth secrets are required as for the Cloudflare deploy; Bun loads
them from `.env` in this directory. To complete a browser login locally, add
a second redirect URI to the Google OAuth client:

```txt
http://localhost:43118/auth/callback/google
```
