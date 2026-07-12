/*
 * First tests owned by the shared workspace itself. shared code is also
 * exercised transitively through cli and server suites; these cover the
 * dependency-free codecs directly.
 */
import { describe, expect, test } from "bun:test";
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  decodedBase64ByteLength,
} from "../src/encoding/base64";
import { isRecord, parseJson } from "../src/util/json";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("base64", () => {
  test("round-trips every 0–2 padding length", () => {
    for (const input of [bytes(), bytes(1), bytes(1, 2), bytes(1, 2, 3), bytes(255, 0, 128, 7)]) {
      expect(base64ToBytes(bytesToBase64(input))).toEqual(input);
    }
  });

  test("matches the standard alphabet and padding", () => {
    expect(bytesToBase64(new TextEncoder().encode("Ma"))).toBe("TWE=");
    expect(base64ToBytes("TWFu")).toEqual(new TextEncoder().encode("Man"));
  });

  test("returns null for invalid input instead of throwing", () => {
    expect(base64ToBytes("not base64!")).toBeNull();
    expect(base64ToBytes("TWE")).toBeNull();
    expect(base64ToBytes("TW==E===")).toBeNull();
  });

  test("decodedBase64ByteLength matches actual decoded length", () => {
    for (const input of [bytes(), bytes(9), bytes(9, 8), bytes(9, 8, 7)]) {
      expect(decodedBase64ByteLength(bytesToBase64(input))).toBe(input.length);
    }
    expect(decodedBase64ByteLength("###")).toBeNull();
  });
});

describe("base64url", () => {
  test("round-trips without padding using the URL-safe alphabet", () => {
    const input = bytes(251, 239, 190);
    const encoded = bytesToBase64Url(input);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(base64UrlToBytes(encoded)).toEqual(input);
  });

  test("returns null for standard-alphabet or truncated input", () => {
    expect(base64UrlToBytes("++++")).toBeNull();
    expect(base64UrlToBytes("TWFué")).toBeNull();
    expect(base64UrlToBytes("A")).toBeNull();
  });
});

describe("json", () => {
  test("parseJson returns the value or null, never throws", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson("nope")).toBeNull();
  });

  test("isRecord accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});
