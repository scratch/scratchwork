# create-scratchwork-server

Scaffolds a standalone, self-hosted
[Scratchwork](https://github.com/scratch/scratchwork) publishing server
project:

```sh
npm create scratchwork-server my-server -- --platform cloudflare
```

Platforms:

- `cloudflare` — a Cloudflare Worker backed by R2 and D1
- `aws` — an AWS Lambda Function URL backed by S3 and DynamoDB
- `local` — a single-machine Bun server with local file storage

The scaffolded project depends on the matching published
`@scratchwork/server-deploy-*` package (pinned to this package's version) and
contains the same files as the Scratchwork repository's own deploy projects:
a `server-config.ts` for domains and auth policy, platform configuration,
`deploy.ts` / `local.ts` entrypoints, a `.env.example` for secrets, and a
README with setup instructions.

```sh
cd my-server
bun install
bun run local    # run the server locally
bun run deploy   # deploy it (cloudflare and aws)
```

The scaffolder is non-interactive when given a directory and `--platform`
(it prompts for the platform only on a TTY). Run with `--help` for usage.
