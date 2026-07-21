# @scratchwork/shared

Code shared between the [Scratchwork](https://github.com/scratch/scratchwork)
CLI and server: the publish API contract (Effect Schemas + `HttpApi`), site
serving helpers, and small utilities. You normally don't depend on this
directly — it comes in as a dependency of `@scratchwork/server-core` and the
deploy packages.

Published as built ESM JavaScript with type declarations; works under Node ≥ 22
or Bun. Every module is importable by subpath, e.g.:

```ts
import { ScratchworkApi } from "@scratchwork/shared/publish/api";
import { contentType } from "@scratchwork/shared/site/content";
```

Part of the Scratchwork repository — see the
[repo](https://github.com/scratch/scratchwork) for development, and
`server/README.md` there for the deploy-your-own walkthrough. MIT license.
