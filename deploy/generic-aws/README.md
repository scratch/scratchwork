# generic-aws

> **Placeholder.** This project is only here in case we want to spend more time
> developing our AWS deploy capabilities. It is not attached to a domain and is
> not part of any production setup — real deployments live in sibling projects
> like `deploy/cloudflare-vanilla`.

Deploys the Scratchwork server as an AWS Lambda Function URL backed by S3 and
DynamoDB, using the `@scratchwork/server-deploy-aws` adapter with generic,
environment-driven names.

Deploy from the repo root (uses the AWS CLI credentials in your environment):

```sh
bun run deploy:generic-aws
```

Run the same server config locally:

```sh
bun run local:generic-aws
```

Configuration comes from `.env` in this directory or the shell; see
`server/README.md` for the full list of `SCRATCHWORK_*` variables, including
the required OAuth settings and the optional `SCRATCHWORK_AWS_*` names for the
function, role, bucket, and table.
