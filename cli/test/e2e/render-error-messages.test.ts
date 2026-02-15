import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { runCliCapture, withSandboxProject } from "./util";

describe("Render error messages", () => {
  test("build fails with helpful message when component has non-component default export", async () => {
    await withSandboxProject(async (sandboxDir, tempDir) => {
      // 1. Create a component that exports a plain object instead of a React component
      const srcDir = path.join(sandboxDir, "src");
      await mkdir(srcDir, { recursive: true });
      await writeFile(
        path.join(srcDir, "BrokenWidget.tsx"),
        `export default { broken: true };\n`
      );

      // 2. Create an MDX page that uses the broken component
      await writeFile(
        path.join(sandboxDir, "pages", "index.mdx"),
        `# Test Page\n\n<BrokenWidget />\n`
      );

      // 3. Build should fail (SSG renders the component, surfacing the error)
      const result = runCliCapture(["build", "sandbox"], tempDir);

      // 4. Verify build failed with helpful error message
      expect(result.status).not.toBe(0);
      const output = result.stderr + result.stdout;
      expect(output).toContain("index.mdx");
      expect(output).toContain("couldn't be rendered");
      expect(output).toContain("Missing component");
    }, "render-error-msg-");
  }, 180_000);
});
