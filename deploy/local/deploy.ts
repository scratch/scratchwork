import { runLocalServer } from "./run";

await runLocalServer({
  server: {
    projectPath: "workspace/project",
    defaultVisibility: "public",
  },
});
