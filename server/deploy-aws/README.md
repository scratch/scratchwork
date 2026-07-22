# @scratchwork/server-deploy-aws

AWS deployment package for the
[Scratchwork](https://github.com/scratch/scratchwork) publishing server:
Lambda handler plus S3 (`ObjectStorage`) and DynamoDB (`PrimitiveDb`)
adapters for `@scratchwork/server-core`.

```ts
import { handler } from "@scratchwork/server-deploy-aws/handler";
```

Published as built ESM JavaScript with type declarations; works under Node ≥ 22
or Bun. To deploy your own server, start from the walkthrough in the
[repo](https://github.com/scratch/scratchwork)'s `server/README.md` and the
`deploy/generic-aws` template. MIT license.
