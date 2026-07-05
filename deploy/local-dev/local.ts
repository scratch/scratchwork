import { runLocalServer } from "@scratchwork/server-deploy-local";

// Generic local development server: local file storage, in-memory database, no
// cloud counterpart. Domain deploys live in sibling projects such as deploy/sndbx.sh.
runLocalServer({
  server: {
    usersCanSetProjectNames: true,
    defaultVisibility: "public",
  },
});
