# Scratchwork server on AWS

A self-hosted [Scratchwork](https://github.com/scratch/scratchwork) publishing
server, deployed as an AWS Lambda Function URL backed by S3 and DynamoDB.

## Configure

1. Edit `server-config.ts` — auth policy and any fixed settings. Settings not
   listed there come from `SCRATCHWORK_*` environment variables.
2. Copy `.env.example` to `.env` and fill in the public URLs, the Google OAuth
   credentials, and the session secret (the comments in `.env.example` explain
   each value).

Configure your Google OAuth app with the redirect URI
`https://<your server host>/auth/callback/google`.

## Run locally

```sh
bun install
bun run local
```

This runs the same server settings locally with local file storage and an
in-memory database (no AWS resources). For local browser logins, add
`http://localhost:43118/auth/callback/google` as a second redirect URI on the
Google OAuth client.

## Deploy

```sh
bun run deploy
```

The deploy uses the AWS credentials in your environment and creates or
updates the S3 bucket, an IAM role, the Lambda function, and a public Lambda
Function URL. Then publish to your server with the
[Scratchwork CLI](https://github.com/scratch/scratchwork):

```sh
scratchwork publish --server <your function url>
```
