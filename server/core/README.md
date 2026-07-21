# @scratchwork/server-core

The platform-neutral core of the
[Scratchwork](https://github.com/scratch/scratchwork) publishing server:
auth, routing, and the storage contracts (`PrimitiveDb`, `ObjectStorage`)
that deploy targets implement. Written with
[Effect](https://effect.website).

You normally consume it through a deploy package rather than directly:

- `@scratchwork/server-deploy-aws` — AWS Lambda + S3/DynamoDB
- `@scratchwork/server-deploy-cloudflare` — Cloudflare Worker + R2/D1
- `@scratchwork/server-deploy-local` — local Bun server

```ts
import { makeApp } from "@scratchwork/server-core";
import { PrimitiveDb } from "@scratchwork/server-core/db";
import { ObjectStorage } from "@scratchwork/server-core/storage";
```

Published as built ESM JavaScript with type declarations; works under Node ≥ 22
or Bun. See the [repo](https://github.com/scratch/scratchwork)'s
`server/README.md` for the deploy-your-own walkthrough. MIT license.
