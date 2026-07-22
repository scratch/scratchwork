/*
 * Tests the template generation + scaffolding loop against the real deploy/*
 * sources: templates are generated exactly as build-packages.ts stages them,
 * then scaffolded the way the published bin does it. The hermetic
 * pack-install-typecheck of every scaffolded template runs in the root gate
 * (scripts/check-npm-pack.ts); these tests cover the scaffolder's own
 * behavior and the template transform's guarantees.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTemplates, TEMPLATE_SOURCES } from "../generate-templates.ts";
import { listPlatforms, projectNameFor, scaffold } from "../src/scaffold.ts";

const workDir = mkdtempSync(join(tmpdir(), "create-scratchwork-test-"));
const templatesDir = join(workDir, "templates");
const version = "9.9.9-test";
generateTemplates(templatesDir, version);

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const platforms = Object.keys(TEMPLATE_SOURCES).sort();

describe("generateTemplates", () => {
  test("produces one template per platform", () => {
    expect(listPlatforms(templatesDir)).toEqual(platforms);
  });

  test.each(platforms)("%s: pins @scratchwork deps to the exact version, no workspace ranges", (platform) => {
    const manifest = JSON.parse(readFileSync(join(templatesDir, platform, "package.json"), "utf8"));
    const dependencies = Object.entries(manifest.dependencies as Record<string, string>);
    expect(dependencies.length).toBeGreaterThan(0);
    for (const [name, range] of dependencies) {
      if (name.startsWith("@scratchwork/")) expect(range).toBe(version);
      expect(range).not.toContain("workspace:");
    }
    expect(manifest.private).toBe(true);
    expect(manifest.scripts.ci).toBeUndefined();
    expect(manifest.scripts.test).toBeUndefined();
    expect(manifest.scripts.typecheck).toBeDefined();
    expect(manifest.scripts.local).toBeDefined();
  });

  test.each(platforms)("%s: tsconfig does not reach into the repository", (platform) => {
    const tsconfig = JSON.parse(readFileSync(join(templatesDir, platform, "tsconfig.json"), "utf8"));
    expect(tsconfig.include.length).toBeGreaterThan(0);
    for (const pattern of tsconfig.include as string[]) {
      expect(pattern.startsWith("..")).toBe(false);
    }
  });

  test.each(platforms)("%s: no sndbx.sh values or bare dotfiles remain", (platform) => {
    for (const name of readdirSync(join(templatesDir, platform))) {
      expect(name.startsWith(".")).toBe(false);
      const text = readFileSync(join(templatesDir, platform, name), "utf8");
      expect(text).not.toContain("sndbx");
    }
  });

  test.each(platforms)("%s: template carries every code file of its deploy project", (platform) => {
    const sourceDir = join(import.meta.dir, "..", "..", TEMPLATE_SOURCES[platform as keyof typeof TEMPLATE_SOURCES]);
    const codeFiles = readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name);
    expect(codeFiles.length).toBeGreaterThan(0);
    for (const name of codeFiles) {
      expect(existsSync(join(templatesDir, platform, name))).toBe(true);
    }
  });
});

describe("scaffold", () => {
  test("materializes dotfiles and personalizes package.json", () => {
    const target = join(workDir, "My Server!");
    const result = scaffold(templatesDir, "cloudflare", target);
    expect(result.projectName).toBe("my-server-");
    expect(existsSync(join(target, ".gitignore"))).toBe(true);
    expect(existsSync(join(target, ".env.example"))).toBe(true);
    expect(readdirSync(target).some((name) => name.startsWith("_"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    expect(manifest.name).toBe("my-server-");
    expect(result.scripts).toContain("deploy");
    expect(result.scripts).toContain("local");
  });

  test("local platform scaffolds without a deploy script or env example", () => {
    const result = scaffold(templatesDir, "local", join(workDir, "local-server"));
    expect(result.scripts).not.toContain("deploy");
    expect(result.hasEnvExample).toBe(false);
    expect(result.scripts).toContain("local");
  });

  test("refuses a non-empty target directory", () => {
    const target = join(workDir, "occupied");
    scaffold(templatesDir, "aws", target);
    expect(() => scaffold(templatesDir, "aws", target)).toThrow(/not empty/);
  });

  test("rejects an unknown platform", () => {
    expect(() => scaffold(templatesDir, "vercel", join(workDir, "nope"))).toThrow(/unknown platform/);
  });

  test("refuses a target that is an existing file", () => {
    const file = join(workDir, "a-file");
    writeFileSync(file, "hi");
    expect(() => scaffold(templatesDir, "aws", file)).toThrow(/not a directory/);
  });
});

describe("projectNameFor", () => {
  test("derives a valid npm name from the directory basename", () => {
    expect(projectNameFor("/tmp/x/Cool_Server")).toBe("cool_server");
    expect(projectNameFor("...")).toBe("scratchwork-server");
  });
});

describe("bin", () => {
  // The templates dir the bin resolves (../templates from src) does not exist
  // in the repo — templates are generated at pack time — so bin tests run
  // against a copy of src laid out next to the generated templates, mirroring
  // the published package (pkg/{src,templates,package.json}).
  Bun.spawnSync(["mkdir", "-p", join(workDir, "pkg")]);
  Bun.spawnSync(["cp", "-R", join(import.meta.dir, "..", "src"), join(workDir, "pkg", "src")]);
  Bun.spawnSync(["cp", join(import.meta.dir, "..", "package.json"), join(workDir, "pkg", "package.json")]);
  Bun.spawnSync(["cp", "-R", templatesDir, join(workDir, "pkg", "templates")]);
  const run = (args: string[], cwd: string) =>
    Bun.spawnSync(["bun", join(workDir, "pkg", "src", "index.ts"), ...args], { cwd, stdout: "pipe", stderr: "pipe" });

  test("scaffolds non-interactively with args alone", () => {
    const cwd = join(workDir, "bin-run");
    Bun.spawnSync(["mkdir", "-p", cwd]);
    const result = run(["agent-server", "--platform", "aws"], cwd);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(cwd, "agent-server", "deploy.ts"))).toBe(true);
    expect(result.stdout.toString()).toContain("bun run deploy");
  });

  test("fails with usage when --platform is missing and stdin is not a TTY", () => {
    const cwd = join(workDir, "bin-fail");
    Bun.spawnSync(["mkdir", "-p", cwd]);
    const result = run(["another-server"], cwd);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--platform is required");
    expect(existsSync(join(cwd, "another-server"))).toBe(false);
  });

  test("--help prints usage", () => {
    const result = run(["--help"], workDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("npm create scratchwork-server");
  });
});
