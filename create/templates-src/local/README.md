# Scratchwork server (local)

A self-hosted [Scratchwork](https://github.com/scratch/scratchwork) publishing
server that runs on a single machine under Bun, with local file storage and an
in-memory database. There is no cloud counterpart and no deploy step.

## Configure

Auth is required and cannot be disabled. Provide Google OAuth credentials and
a session secret in the shell environment:

```sh
SCRATCHWORK_GOOGLE_CLIENT_ID=...
SCRATCHWORK_GOOGLE_CLIENT_SECRET=...
SCRATCHWORK_SESSION_SECRET=...  # at least 32 bytes; openssl rand -base64 48
```

Configure your Google OAuth app with the redirect URI
`http://localhost:43118/auth/callback/google`.

Useful environment variables:

```sh
PORT=43118
SCRATCHWORK_STORAGE_DIR=.scratchwork-local-data
```

Edit `local.ts` to change fixed server settings (allowed users, project
naming, and so on).

## Run

```sh
bun install
bun run local
```

Then publish to it with the
[Scratchwork CLI](https://github.com/scratch/scratchwork):

```sh
scratchwork publish --server http://localhost:43118
```
