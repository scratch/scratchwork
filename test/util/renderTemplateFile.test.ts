import { describe, expect, test, mock } from "bun:test";
import fs from "fs/promises";
import { renderTemplateFile } from "../../src/util";

describe("renderTemplateFile", () => {
  test("reads template file and renders it with variables", async () => {
    const templatePath = "/path/to/template.html";
    const templateContent = "Hello, {{name}}! Welcome to {{project}}.";
    const variables = {
      name: "User",
      project: "scratch"
    };
    
    // Mock fs.readFile
    const originalReadFile = fs.readFile;
    // @ts-ignore - Mock implementation
    fs.readFile = mock((path: string, encoding: string) => {
      expect(path).toBe(templatePath);
      expect(encoding).toBe("utf-8");
      return Promise.resolve(templateContent);
    });
    
    const result = await renderTemplateFile(templatePath, variables);
    expect(result).toBe("Hello, User! Welcome to scratch.");
    
    // Verify the mock was called
    expect(fs.readFile).toHaveBeenCalledTimes(1);
    
    // Restore original function
    fs.readFile = originalReadFile;
  });
});
