# Cloudflare deploy package

Deploys the Scratchwork server as a Cloudflare Worker backed by R2 and D1. It can
also run that exact Worker locally through Wrangler/workerd, with persistent local R2
and D1 bindings.

## Local Cloudflare runtime

From the repository root, start the generic configuration with:

```sh
bun run local:cloudflare
```

The normal auth configuration is still required. For an offline run that also
simulates Cloudflare Access, select a local identity instead:

```sh
SCRATCHWORK_LOCAL_CF_ACCESS_EMAIL=developer@example.com bun run local:cloudflare
```

The server listens at `http://localhost:8787`. R2 and D1 data persist under
`.scratchwork-cloudflare-data/`; remove that ignored directory when you need a clean
environment. Override the defaults with `PORT` and `SCRATCHWORK_LOCAL_CF_ACCESS_EMAIL`.
The launcher writes secret bindings to the ignored `dist/.dev.vars` file so Wrangler
does not display them as ordinary configuration variables.
With the Access simulator running, a second terminal can exercise all three emulated
pieces in one login/publish/read smoke test:

```sh
cd server/deploy-cloudflare
bun run smoke:local
```

Deploy projects can use their production server and binding names locally:

```ts
import {
  runLocalCloudflareServer,
  type CloudflareDeployServerConfig,
} from "@scratchwork/server-deploy-cloudflare";

const config = {
  server: {
    appDomain: "app.example.com",
    contentDomain: "pages.example.com",
    auth: "cloudflare-access",
  },
  deploy: {
    workerName: "scratchwork-example",
    r2Bucket: "scratchwork-example",
    d1Database: "scratchwork-example-projects",
  },
} satisfies CloudflareDeployServerConfig;

await runLocalCloudflareServer(config, {
  envFile: ".env",
  simulateAccess: { email: "developer@example.com" },
});
```

`simulateAccess: true` uses `developer@example.com`. Set it to `false` to test the
server's missing-assertion response even when the environment variable is present.

Wrangler runs the Worker under the same `workerd` runtime used by Cloudflare and
creates local R2 and D1 implementations. The Access edge itself is not part of
Wrangler, so the package adds a local-only wrapper: it generates a throwaway RSA key,
issues a short-lived `Cf-Access-Jwt-Assertion` for the selected email, and lets the
production auth code verify its signature, issuer, audience, and expiry. It simulates
an already-authenticated Access session; it does not reproduce an identity provider's
login UI or Cloudflare policy engine.

## Deploy

```ts
import { deployServer } from "@scratchwork/server-deploy-cloudflare";

await deployServer(config, { envFile: ".env" });
```

See the repository's `server/README.md` for all server and deployment settings.
