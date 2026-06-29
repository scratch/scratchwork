import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeployEnv } from "./env";

describe("loadDeployEnv", () => {
  test("loads server, package, explicit env files with shell precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "scratchwork-env-"));
    const packageRoot = join(root, "server", "deploy-cloudflare");
    try {
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(root, "server", ".env"), "VALUE=server\nSERVER_ONLY=1\n");
      await writeFile(join(packageRoot, ".env"), "VALUE=package\nPACKAGE_ONLY=1\n");
      await writeFile(join(root, "custom.env"), "VALUE=explicit\nEXPLICIT_ONLY=1\n");

      const loaded = await loadDeployEnv({
        packageRoot,
        argv: ["--env", "custom.env"],
        processEnv: { VALUE: "shell", SHELL_ONLY: "1" },
      });

      expect(loaded.env.VALUE).toBe("shell");
      expect(loaded.env.SERVER_ONLY).toBe("1");
      expect(loaded.env.PACKAGE_ONLY).toBe("1");
      expect(loaded.env.EXPLICIT_ONLY).toBe("1");
      expect(loaded.env.SHELL_ONLY).toBe("1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
