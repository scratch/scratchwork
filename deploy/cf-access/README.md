# Local Cloudflare Access deploy

Local-only Scratchwork deployment for testing the Cloudflare Worker, R2, D1, and
Cloudflare Access authentication together. It has no remote `deploy` command and
needs no Cloudflare account or OAuth credentials.

From the repository root:

```sh
bun run local:cf-access
```

It listens on `http://localhost:8787` and signs Access assertions for
`developer@example.com`. Select another identity with:

```sh
SCRATCHWORK_LOCAL_CF_ACCESS_EMAIL=alice@example.com bun run local:cf-access
```

R2 and D1 data persist under `deploy/cf-access/.scratchwork-cloudflare-data/`.
Remove that ignored directory for an empty environment. This simulates an
already-authenticated Access session and its signed identity assertion, not the
Cloudflare policy engine or an identity provider's login UI.
