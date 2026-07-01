import { describe, expect, test } from "bun:test";
import { normalizeServerUrl } from "../src/auth";

describe("normalizeServerUrl", () => {
  test("defaults bare public hosts to https", () => {
    expect(normalizeServerUrl("sndbx.sh")).toBe("https://sndbx.sh");
    expect(normalizeServerUrl("sndbx.sh/")).toBe("https://sndbx.sh");
  });

  test("defaults loopback hosts to http", () => {
    expect(normalizeServerUrl("localhost:3001")).toBe("http://localhost:3001");
    expect(normalizeServerUrl("127.0.0.1:3001")).toBe("http://127.0.0.1:3001");
  });

  test("preserves explicit schemes and removes search/hash", () => {
    expect(normalizeServerUrl("https://www.sndbx.sh/?x=1#top")).toBe("https://www.sndbx.sh");
    expect(normalizeServerUrl("http://localhost:3001/")).toBe("http://localhost:3001");
  });
});
