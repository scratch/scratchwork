import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import { decodePublishRequest, MAX_PUBLISH_FILE_BYTES, MAX_PUBLISH_FILES, MAX_PUBLISH_TOTAL_BYTES } from "../src/publish-request";
import { bundle } from "./helpers";

describe("decodePublishRequest", () => {
  test("decodes a valid request", async () => {
    const request = await Effect.runPromise(decodePublishRequest({
      bundle: bundle({ "index.html": "hello" }),
      openPath: "//docs///",
      project: "site_docs",
      isPublic: true,
    }));

    expect(request.openPath).toBe("/docs/");
    expect(request.project).toBe("site_docs");
    expect(request.isPublic).toBe(true);
    expect(request.totalBytes).toBe(5);
  });

  test("rejects duplicate and unsafe file paths", async () => {
    await expect(Effect.runPromise(decodePublishRequest({
      bundle: {
        version: 1,
        files: [
          { path: "index.html", contentBase64: Encoding.encodeBase64(new TextEncoder().encode("a")) },
          { path: "index.html", contentBase64: Encoding.encodeBase64(new TextEncoder().encode("b")) },
        ],
      },
    }))).rejects.toThrow("Duplicate file path");

    await expect(Effect.runPromise(decodePublishRequest({
      bundle: {
        version: 1,
        files: [{ path: "../secret", contentBase64: Encoding.encodeBase64(new TextEncoder().encode("x")) }],
      },
    }))).rejects.toThrow("Invalid site path");
  });

  test("rejects invalid base64 and invalid openPath", async () => {
    await expect(Effect.runPromise(decodePublishRequest({
      bundle: { version: 1, files: [{ path: "index.html", contentBase64: "not base64!" }] },
    }))).rejects.toThrow("Invalid base64");

    await expect(Effect.runPromise(decodePublishRequest({
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/page#fragment",
    }))).rejects.toThrow("Invalid openPath");

    await expect(Effect.runPromise(decodePublishRequest({
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/%2e%2e/api/me",
    }))).rejects.toThrow("Invalid openPath");
  });

  test("validates project and isPublic", async () => {
    await expect(Effect.runPromise(decodePublishRequest({
      bundle: bundle({ "index.html": "hello" }),
      project: "../bad",
    }))).rejects.toThrow("Invalid project");

    // Uppercase names fail the lowercase-only grammar.
    await expect(Effect.runPromise(decodePublishRequest({
      bundle: bundle({ "index.html": "hello" }),
      project: "Docs",
    }))).rejects.toThrow("Invalid project");

    // isPublic is strictly boolean; strings are not silently accepted.
    await expect(Effect.runPromise(decodePublishRequest({
      bundle: bundle({ "index.html": "hello" }),
      project: "site",
      isPublic: "public",
    }))).rejects.toThrow("Expected boolean");
  });

  test("rejects the retired workspace field as an excess property", async () => {
    await expect(Effect.runPromise(decodePublishRequest({
      bundle: bundle({ "index.html": "hello" }),
      workspace: "demo",
      project: "site",
    }))).rejects.toThrow("workspace");
  });

  test("enforces file count and byte limits", async () => {
    await expect(Effect.runPromise(decodePublishRequest({
      bundle: {
        version: 1,
        files: Array.from({ length: MAX_PUBLISH_FILES + 1 }, (_, index) => ({
          path: `file-${index}.txt`,
          contentBase64: Encoding.encodeBase64(new Uint8Array([index % 255])),
        })),
      },
    }))).rejects.toThrow("too many files");

    await expect(Effect.runPromise(decodePublishRequest({
      bundle: {
        version: 1,
        files: [{ path: "big.bin", contentBase64: Encoding.encodeBase64(new Uint8Array(MAX_PUBLISH_FILE_BYTES + 1)) }],
      },
    }))).rejects.toThrow("too large");

    const third = new Uint8Array(Math.floor(MAX_PUBLISH_TOTAL_BYTES / 3) + 1);
    await expect(Effect.runPromise(decodePublishRequest({
      bundle: {
        version: 1,
        files: [
          { path: "a.bin", contentBase64: Encoding.encodeBase64(third) },
          { path: "b.bin", contentBase64: Encoding.encodeBase64(third) },
          { path: "c.bin", contentBase64: Encoding.encodeBase64(third) },
          { path: "d.bin", contentBase64: Encoding.encodeBase64(third) },
        ],
      },
    }))).rejects.toThrow("Publish bundle is too large");
  });
});
