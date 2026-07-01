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

The domain settings live in `deploy.ts`. Secrets are read from `.env` in this
directory and the shell environment; this deploy project does not read
`server/.env`. It binds the Worker with the `sndbx.sh/*` route so the existing
DNS records can stay in place. The Worker name is `scratchwork`, matching the
existing Cloudflare route assignment for that hostname.

Configure the Google OAuth redirect URI as:

```txt
https://sndbx.sh/auth/callback/google
```
