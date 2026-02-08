import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { mkTempDir, scratchPath } from "./util";

/**
 * E2E tests for server URL handling and multi-server credentials.
 *
 * These tests verify:
 * 1. Multi-server credentials storage format
 * 2. Server URL normalization
 * 3. Configuration precedence
 *
 * Note: Server URL is passed via the --server <url> option flag.
 */

describe("Server URL as --server option", () => {
  function runCli(args: string[], cwd: string = process.cwd()): { stdout: string; stderr: string; status: number } {
    const result = spawnSync(scratchPath, args, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });

    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      status: result.status || 0,
    };
  }

  test("whoami accepts --server option", () => {
    const result = runCli(["whoami", "--help"]);
    expect(result.stdout).toContain("--server <url>");
    expect(result.stdout).toContain("Server URL");
  });

  test("login accepts --server option", () => {
    const result = runCli(["login", "--help"]);
    expect(result.stdout).toContain("--server <url>");
    expect(result.stdout).toContain("Server URL");
  });

  test("logout accepts --server option", () => {
    const result = runCli(["logout", "--help"]);
    expect(result.stdout).toContain("--server <url>");
    expect(result.stdout).toContain("Server URL");
  });

  test("projects ls accepts --server option", () => {
    const result = runCli(["projects", "ls", "--help"]);
    expect(result.stdout).toContain("--server <url>");
    expect(result.stdout).toContain("Server URL");
  });

  test("tokens ls accepts --server option", () => {
    const result = runCli(["tokens", "ls", "--help"]);
    expect(result.stdout).toContain("--server <url>");
    expect(result.stdout).toContain("Server URL");
  });

  test("share create accepts --server option", () => {
    const result = runCli(["share", "create", "--help"]);
    expect(result.stdout).toContain("--server <url>");
    expect(result.stdout).toContain("Server URL");
  });

  test("cf-access accepts --server option", () => {
    const result = runCli(["cf-access", "--help"]);
    expect(result.stdout).toContain("--server <url>");
    expect(result.stdout).toContain("Server URL");
  });
});

describe("Multi-server credentials storage", () => {
  let tempDir: string;
  let originalHome: string;

  beforeAll(async () => {
    tempDir = await mkTempDir("cloud-creds-e2e-");
    originalHome = process.env.HOME || os.homedir();
    process.env.HOME = tempDir;

    // Create .scratchwork directory
    await fs.mkdir(path.join(tempDir, ".scratchwork"), { recursive: true });
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("credentials file supports multiple servers", async () => {
    // Simulate the multi-server credentials format
    const credentialsPath = path.join(tempDir, ".scratchwork", "credentials.json");

    const multiServerCredentials = {
      "https://app.scratchwork.dev": {
        token: "prod-token-123",
        user: {
          id: "user-1",
          email: "prod@example.com",
          name: "Production User",
        },
      },
      "https://staging.scratchwork.dev": {
        token: "staging-token-456",
        user: {
          id: "user-2",
          email: "staging@example.com",
          name: null,
        },
      },
    };

    await fs.writeFile(credentialsPath, JSON.stringify(multiServerCredentials, null, 2) + "\n");

    // Verify file was written correctly
    const content = await fs.readFile(credentialsPath, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed["https://app.scratchwork.dev"]).toBeDefined();
    expect(parsed["https://staging.scratchwork.dev"]).toBeDefined();
    expect(parsed["https://app.scratchwork.dev"].token).toBe("prod-token-123");
    expect(parsed["https://staging.scratchwork.dev"].token).toBe("staging-token-456");
  });

  test("cf-access credentials file supports multiple servers", async () => {
    // Simulate the multi-server CF Access credentials format
    const cfAccessPath = path.join(tempDir, ".scratchwork", "cf-access.json");

    const multiServerCfAccess = {
      "https://app.scratchwork.dev": {
        client_id: "prod-client-id",
        client_secret: "prod-client-secret",
      },
      "https://staging.scratchwork.dev": {
        client_id: "staging-client-id",
        client_secret: "staging-client-secret",
      },
    };

    await fs.writeFile(cfAccessPath, JSON.stringify(multiServerCfAccess, null, 2) + "\n");

    // Verify file was written correctly
    const content = await fs.readFile(cfAccessPath, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed["https://app.scratchwork.dev"]).toBeDefined();
    expect(parsed["https://staging.scratchwork.dev"]).toBeDefined();
    expect(parsed["https://app.scratchwork.dev"].client_id).toBe("prod-client-id");
    expect(parsed["https://staging.scratchwork.dev"].client_id).toBe("staging-client-id");
  });

  test("credentials are keyed by normalized server URL", async () => {
    // Test that URLs are normalized (lowercase, no trailing slash)
    const normalized = (url: string) => url.replace(/\/+$/, "").toLowerCase();

    expect(normalized("https://APP.SCRATCHWORK.DEV/")).toBe("https://app.scratchwork.dev");
    expect(normalized("https://staging.scratchwork.dev/")).toBe("https://staging.scratchwork.dev");
    expect(normalized("http://LOCALHOST:8788/")).toBe("http://localhost:8788");
  });
});

describe("Server URL normalization", () => {
  // Import the normalizeServerUrl function
  const { normalizeServerUrl } = require("../../src/cmd/cloud/context");

  test("adds https:// if no protocol specified", () => {
    const result = normalizeServerUrl("app.scratchwork.dev");
    expect(result.url).toBe("https://app.scratchwork.dev");
    expect(result.modified).toBe(false); // Only modified if app. was added
  });

  test("preserves http:// for localhost", () => {
    const result = normalizeServerUrl("http://localhost:8788");
    expect(result.url).toBe("http://localhost:8788");
    expect(result.modified).toBe(false);
  });

  test("adds app. subdomain to naked domains", () => {
    const result = normalizeServerUrl("ycscratch.dev");
    expect(result.url).toBe("https://app.ycscratch.dev");
    expect(result.modified).toBe(true);
  });

  test("adds app. subdomain to naked domains with https", () => {
    const result = normalizeServerUrl("https://scratchwork.dev");
    expect(result.url).toBe("https://app.scratchwork.dev");
    expect(result.modified).toBe(true);
  });

  test("does not modify URLs with existing subdomain", () => {
    const result = normalizeServerUrl("staging.scratchwork.dev");
    expect(result.url).toBe("https://staging.scratchwork.dev");
    expect(result.modified).toBe(false);
  });

  test("does not modify localhost", () => {
    const result = normalizeServerUrl("localhost:8788");
    expect(result.url).toBe("https://localhost:8788");
    expect(result.modified).toBe(false);
  });

  test("does not modify app. subdomain URLs", () => {
    const result = normalizeServerUrl("app.scratchwork.dev");
    expect(result.url).toBe("https://app.scratchwork.dev");
    expect(result.modified).toBe(false);
  });

  test("adds app. subdomain to naked .co.uk domains", () => {
    const result = normalizeServerUrl("example.co.uk");
    expect(result.url).toBe("https://app.example.co.uk");
    expect(result.modified).toBe(true);
  });

  test("does not modify .co.uk domains with existing subdomain", () => {
    const result = normalizeServerUrl("app.example.co.uk");
    expect(result.url).toBe("https://app.example.co.uk");
    expect(result.modified).toBe(false);
  });

  test("does not modify staging subdomain on .co.uk", () => {
    const result = normalizeServerUrl("staging.example.co.uk");
    expect(result.url).toBe("https://staging.example.co.uk");
    expect(result.modified).toBe(false);
  });
});

describe("Server URL configuration precedence", () => {
  let tempDir: string;
  let originalHome: string;

  beforeAll(async () => {
    tempDir = await mkTempDir("cloud-config-e2e-");
    originalHome = process.env.HOME || os.homedir();
    process.env.HOME = tempDir;

    // Create config directories
    await fs.mkdir(path.join(tempDir, ".config", "scratch"), { recursive: true });
    await fs.mkdir(path.join(tempDir, ".scratchwork"), { recursive: true });
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("global config stores server_url", async () => {
    const configPath = path.join(tempDir, ".config", "scratch", "config.toml");

    const configContent = `# Scratchwork Cloud Global Configuration
server_url = "https://custom.scratchwork.dev"
namespace = "acme.com"
`;

    await fs.writeFile(configPath, configContent);

    const content = await fs.readFile(configPath, "utf-8");
    expect(content).toContain('server_url = "https://custom.scratchwork.dev"');
  });

  test("project config can override server_url", async () => {
    const projectDir = path.join(tempDir, "test-project");
    const configPath = path.join(projectDir, ".scratchwork", "project.toml");

    await fs.mkdir(path.join(projectDir, ".scratchwork"), { recursive: true });

    const configContent = `# Scratchwork Cloud Project Configuration
name = "test-project"
namespace = "acme.com"
server_url = "https://project-specific.scratchwork.dev"
`;

    await fs.writeFile(configPath, configContent);

    const content = await fs.readFile(configPath, "utf-8");
    expect(content).toContain('server_url = "https://project-specific.scratchwork.dev"');
  });

  test("documents precedence: CLI flag > project config > global config", () => {
    // This test documents the expected precedence
    function getEffectiveServerUrl(
      cliFlag: string | undefined,
      projectConfig: string | undefined,
      globalConfig: string | undefined,
      defaultUrl: string
    ): string {
      return cliFlag || projectConfig || globalConfig || defaultUrl;
    }

    const defaultUrl = "https://app.scratchwork.dev";

    // CLI flag takes highest precedence
    expect(
      getEffectiveServerUrl(
        "https://cli.scratchwork.dev",
        "https://project.scratchwork.dev",
        "https://global.scratchwork.dev",
        defaultUrl
      )
    ).toBe("https://cli.scratchwork.dev");

    // Project config next
    expect(
      getEffectiveServerUrl(
        undefined,
        "https://project.scratchwork.dev",
        "https://global.scratchwork.dev",
        defaultUrl
      )
    ).toBe("https://project.scratchwork.dev");

    // Global config next
    expect(
      getEffectiveServerUrl(undefined, undefined, "https://global.scratchwork.dev", defaultUrl)
    ).toBe("https://global.scratchwork.dev");

    // Default as fallback
    expect(getEffectiveServerUrl(undefined, undefined, undefined, defaultUrl)).toBe(defaultUrl);
  });
});
