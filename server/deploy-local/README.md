# Local Scratchwork deploy

This package runs the shared Scratchwork server app as a local deploy target,
with local file storage and an in-memory database. It lets any deploy project
under `deploy/` run its server config locally.

Run the generic local development server from the repo root:

```sh
bun run local:local-dev
```

OAuth credentials are required (auth cannot be disabled):

```sh
SCRATCHWORK_GOOGLE_CLIENT_ID=...
SCRATCHWORK_GOOGLE_CLIENT_SECRET=...
SCRATCHWORK_SESSION_SECRET=...  # at least 32 bytes
```

Useful environment variables:

```sh
PORT=43118
SCRATCHWORK_STORAGE_DIR=/tmp/scratchwork-local-storage
SCRATCHWORK_PROJECT_PATH=workspace/project
SCRATCHWORK_DEFAULT_VISIBILITY=public
SCRATCHWORK_APP_URL=http://localhost:43118
SCRATCHWORK_CONTENT_URL=http://localhost:43118
```

## Running another deploy's config locally

The package exports `runLocalServer`, which accepts the `server` section of a
Cloudflare/AWS deploy config and runs it locally (environment variables still
win over config values). Deploy projects use it to share one config module
between their cloud deploy and a local run — see `deploy/sndbx.sh/local.ts`:

```ts
import { runLocalServer } from "@scratchwork/server-deploy-local";
import { server } from "./server-config";

runLocalServer({ server });
```

When the config declares distinct app and content domains, the local run
serves the app on `http://localhost:<port>` and content on
`http://pages.localhost:<port>` so host-separated behavior (like the
private-content cookie handoff) works the same way locally. `*.localhost`
names are loopback per RFC 6761; the app stays on plain `localhost` so the
Google OAuth http redirect URI remains valid.
