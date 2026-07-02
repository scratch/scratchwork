# local-dev

Generic local development server. Runs the shared Scratchwork server app with
local file storage and an in-memory database — no cloud counterpart.

Run from the repo root:

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
```

To run a real deploy's server config locally instead, use that project's local
run (for example `bun run local:sndbx.sh`).
