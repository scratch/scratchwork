import { runLocalServer } from "@scratchwork/server-deploy-local";

// Generic local development server: local file storage, in-memory database, no
// cloud counterpart. Domain deploys live in sibling projects such as deploy/cloudflare-vanilla.
runLocalServer({
  server: {
    auth: "oauth",
    usersCanSetProjectNames: true,
    publicByDefault: true,
  },
});
