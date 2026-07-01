# Local Scratchwork deploy

This package runs the shared Scratchwork server app as a local deploy target. It
is intended for end-to-end verification when the Cloudflare deploy cannot be
mutated.

Run from the repo root:

```sh
bun run deploy:local
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
