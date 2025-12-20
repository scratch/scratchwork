import { describe, expect, test } from "bun:test";
import path from "path";
import { getRepoRoot } from "../../src/util";

describe("getRepoRoot", () => {
  test("returns the project root directory", () => {
    // Get the expected repo root by resolving from the test file
    const expectedRoot = path.resolve(__dirname, "../..");
    
    // Call the function under test
    const actualRoot = getRepoRoot();
    
    // Verify paths are identical
    expect(actualRoot).toBe(expectedRoot);
  });
});
