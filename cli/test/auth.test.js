import { describe, expect, test } from "bun:test";
import { normalizeServerUrl } from "../src/auth";

describe("normalizeServerUrl", () => {
  test("defaults bare public hosts to the https app subdomain", () => {
    expect(normalizeServerUrl("sndbx.sh")).toBe("https://www.sndbx.sh");
    expect(normalizeServerUrl("sndbx.sh/")).toBe("https://www.sndbx.sh");
    expect(normalizeServerUrl("https://sndbx.sh")).toBe("https://www.sndbx.sh");
  });

  test("defaults loopback hosts to http", () => {
    expect(normalizeServerUrl("localhost:3001")).toBe("http://localhost:3001");
    expect(normalizeServerUrl("127.0.0.1:3001")).toBe("http://127.0.0.1:3001");
  });

  test("preserves explicit schemes for subdomains and removes search/hash", () => {
    expect(normalizeServerUrl("https://www.sndbx.sh/?x=1#top")).toBe("https://www.sndbx.sh");
    expect(normalizeServerUrl("https://app.sndbx.sh/?x=1#top")).toBe("https://app.sndbx.sh");
    expect(normalizeServerUrl("http://localhost:3001/")).toBe("http://localhost:3001");
  });
});
