import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { accessGroupModify, normalizeAccessGroup } from "../src/access";

/** Runs a modification that is expected to succeed. */
function modify(group: string, changes: { add?: ReadonlyArray<string>; remove?: ReadonlyArray<string> }): string {
  return Effect.runSync(accessGroupModify(group, { add: changes.add ?? [], remove: changes.remove ?? [] }));
}

/** Runs a modification that is expected to fail, returning the error message. */
function modifyError(group: string, changes: { add?: ReadonlyArray<string>; remove?: ReadonlyArray<string> }): string {
  return Effect.runSync(Effect.flip(accessGroupModify(group, { add: changes.add ?? [], remove: changes.remove ?? [] }))).message;
}

describe("accessGroupModify", () => {
  test("adds grants to a private project", () => {
    expect(modify("private", { add: ["Alice@Example.com"] })).toBe("alice@example.com");
    expect(modify("private", { add: ["alice@example.com", "@team.example.com"] }))
      .toBe("alice@example.com,@team.example.com");
  });

  test("keeps existing grants and dedupes re-added ones", () => {
    expect(modify("alice@example.com", { add: ["@example.com"] })).toBe("alice@example.com,@example.com");
    expect(modify("alice@example.com", { add: ["ALICE@example.com"] })).toBe("alice@example.com");
  });

  test("removes exact terms only", () => {
    expect(modify("alice@example.com,@example.com", { remove: ["@example.com"] })).toBe("alice@example.com");
    // An email covered by a domain grant is not the domain term.
    expect(modify("@example.com", { remove: ["alice@example.com"] })).toBe("@example.com");
    // Removing an absent grant is a no-op.
    expect(modify("alice@example.com", { remove: ["bob@example.com"] })).toBe("alice@example.com");
  });

  test("removing the last grant yields private", () => {
    expect(modify("alice@example.com", { remove: ["alice@example.com"] })).toBe("private");
  });

  test("applies adds and removes in one call", () => {
    expect(modify("alice@example.com", { add: ["bob@example.com"], remove: ["alice@example.com"] }))
      .toBe("bob@example.com");
  });

  test("refuses to add grants to a public group; removals are no-ops", () => {
    expect(modifyError("public", { add: ["alice@example.com"] })).toContain('"public"');
    // There is no grant to remove from "public"; revokes of other roles must not fail
    // just because the read group is public.
    expect(modify("public", { remove: ["alice@example.com"] })).toBe("public");
  });

  test("rejects targets that are not an email or @domain", () => {
    for (const target of ["not-an-email", "public", "private", "@not_a_domain", "a@b.com,c@d.com"]) {
      expect(modifyError("private", { add: [target] })).toContain("Invalid share target");
      expect(modifyError("alice@example.com", { remove: [target] })).toContain("Invalid share target");
    }
  });

  test("rejects an invalid stored group", () => {
    expect(modifyError("", { add: ["alice@example.com"] })).toContain("Invalid access group");
  });
});

describe("normalizeAccessGroup", () => {
  test("explains the expected syntax on failure", () => {
    const message = Effect.runSync(Effect.flip(normalizeAccessGroup("gmail.com,koomen.org"))).message;
    expect(message).toBe(
      'Invalid access group "gmail.com,koomen.org": expected "public", "private", or a comma-separated list of email addresses and @domain groups, like "alice@example.com,@example.com"',
    );
  });
});
