import { describe, expect, test } from "bun:test";
import path from "path";
import { resolvePkg } from "../../src/util";

describe("resolvePkg", () => {
  // Test the behavior rather than the implementation
  test("resolves package directory correctly", () => {
    // Pick a real package that will be in node_modules
    const pkg = "path";
    
    // When we resolve a package
    const result = resolvePkg(pkg);
    
    // It should return a directory path
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    
    // It should be a directory path, not a file path
    // We don't know exactly what the path will be, but we can verify some properties
    expect(result).toBeTruthy();
    // The path.dirname function in the resolvePkg implementation should ensure this is a directory
    expect(result.endsWith(".js")).toBe(false);
  });
});
