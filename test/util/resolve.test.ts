import { describe, expect, test } from "bun:test";
import path from "path";
import { resolve } from "../../src/util";

describe("resolve", () => {
  test("returns the absolute path unchanged", () => {
    const absolutePath = "/some/absolute/path";
    expect(resolve(absolutePath)).toBe(absolutePath);
  });

  test("resolves relative path against cwd by default", () => {
    const relativePath = "some/relative/path";
    const expected = path.join(process.cwd(), relativePath);
    expect(resolve(relativePath)).toBe(expected);
  });

  test("resolves relative path against specified root", () => {
    const relativePath = "some/relative/path";
    const root = "/custom/root";
    const expected = path.join(root, relativePath);
    expect(resolve(relativePath, root)).toBe(expected);
  });
});
