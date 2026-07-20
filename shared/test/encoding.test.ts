/*
 * Tests for the one retained base64 helper. The codecs themselves are
 * effect/Encoding (exercised transitively through cli and server suites);
 * what must hold here is that decodedBase64ByteLength accepts exactly the
 * strings Encoding.decodeBase64 accepts and sizes them exactly.
 */
import { describe, expect, test } from "bun:test";
import * as Either from "effect/Either";
import * as Encoding from "effect/Encoding";
import { decodedBase64ByteLength } from "../src/encoding/base64";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("decodedBase64ByteLength", () => {
  test("matches actual decoded length for every 0–2 padding length", () => {
    for (const input of [bytes(), bytes(9), bytes(9, 8), bytes(9, 8, 7), bytes(255, 0, 128, 7)]) {
      expect(decodedBase64ByteLength(Encoding.encodeBase64(input))).toBe(input.length);
    }
  });

  test("returns null for invalid input instead of throwing", () => {
    expect(decodedBase64ByteLength("###")).toBeNull();
    expect(decodedBase64ByteLength("TWE")).toBeNull();
    expect(decodedBase64ByteLength("TW==E===")).toBeNull();
    expect(decodedBase64ByteLength("TW E=")).toBeNull();
  });

  test("agrees with Encoding.decodeBase64 on acceptance and size", () => {
    const corpus = [
      "",
      "TWE=",
      "TWFu",
      "TWFu\n",
      "TWFu\r\n",
      "AA==",
      "====",
      "A===",
      "=AAA",
      "TW=u",
      "TWE",
      "A",
      "TW E=",
      "TWFué",
      "+/+/",
      "-_-_",
      Encoding.encodeBase64(bytes(1, 2, 3, 4, 5)),
    ];
    for (const value of corpus) {
      const decoded = Encoding.decodeBase64(value);
      const length = decodedBase64ByteLength(value);
      if (Either.isRight(decoded)) {
        expect(length).toBe(decoded.right.length);
      } else {
        expect(length).toBeNull();
      }
    }
  });
});
