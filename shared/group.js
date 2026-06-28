/*
 * Visibility groups — the pure, dependency-free logic that decides who a
 * project (or the server's ALLOWED_USERS / MAX_VISIBILITY ceiling) is visible
 * to. Ported from the reference scratch implementation (shared/src/group.ts).
 *
 * A "group" is one of:
 *   "public"                      — everyone
 *   "private"                     — no one (ownership is checked separately)
 *   "@domain.com"                 — anyone with an email at that domain
 *   "user@example.com"            — exactly that email
 *   ["@a.com", "x@b.com", ...]    — the union of the above
 *
 * Kept in shared/ (next to resolve.js, bundle.js) and dependency-free so the
 * zero-dependency CLI binary can import it too.
 */

// A member spec is either an email or an @domain.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_REGEX = /^@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

/**
 * Parse a raw string into a group value.
 * Returns "public" | "private" | string (single member) | string[] (members).
 * Mirrors the reference's first-match-wins precedence, including the fail-open
 * fallback to "public" for empty/unrecognized input.
 */
export function parseGroup(value) {
  if (value === "public") return "public";
  if (value === "private") return "private";

  // Single domain (no comma).
  if (value.startsWith("@") && !value.includes(",")) return value;

  // Comma-separated list.
  if (value.includes(",")) return value.split(",").map((s) => s.trim());

  // Single email.
  if (value.includes("@")) return value;

  // Fallback (matches the reference's permissive default).
  return "public";
}

/**
 * Does `email` belong to `group`?
 *   public  → always true
 *   private → always false (ownership is checked elsewhere)
 * Matching is case-insensitive on both sides. A domain member (`@acme.com`)
 * matches via suffix, anchored by the leading `@` so `@acme.com` matches
 * `user@acme.com` but NOT `user@evilacme.com`.
 */
export function matchesGroup(email, group) {
  if (group === "public") return true;
  if (group === "private") return false;

  const emailLower = String(email).toLowerCase();
  if (typeof group === "string") return memberMatches(emailLower, group);
  return group.some((member) => memberMatches(emailLower, member));
}

function memberMatches(emailLower, member) {
  if (member.startsWith("@")) return emailLower.endsWith(member.toLowerCase());
  return emailLower === member.toLowerCase();
}

/**
 * Validate the raw input format. Returns null when valid, else an error string.
 * "public"/"private" are always valid; each member of a list must be a valid
 * email or @domain.
 */
export function validateGroupInput(value) {
  if (value === "public" || value === "private") return null;
  if (value.includes(",")) {
    for (const part of value.split(",").map((s) => s.trim())) {
      const err = validateSingleMember(part);
      if (err) return err;
    }
    return null;
  }
  return validateSingleMember(value);
}

function validateSingleMember(value) {
  if (value.startsWith("@")) {
    return DOMAIN_REGEX.test(value) ? null : "Invalid domain format. Use @domain.com";
  }
  if (value.includes("@")) {
    return EMAIL_REGEX.test(value) ? null : `Invalid email format: ${value}`;
  }
  return 'Invalid format. Use "public", "private", "@domain.com", or email addresses';
}

/**
 * Does group A contain group B? (Is every member of B also a member of A?)
 * Used to enforce the MAX_VISIBILITY ceiling: a project's visibility must be
 * contained by the ceiling. Ported verbatim from the reference truth table.
 */
export function groupContains(a, b) {
  if (a === "public") return true; // public contains everything
  if (a === "private") return b === "private"; // private contains only private
  if (b === "public") return false; // only public can contain public
  if (b === "private") return true; // anything contains private (most restrictive)

  const aMembers = Array.isArray(a) ? a : [a];
  const bMembers = Array.isArray(b) ? b : [b];
  return bMembers.every((bMember) => memberIsContainedBy(bMember, aMembers));
}

function memberIsContainedBy(bMember, aMembers) {
  const bMemberLower = bMember.toLowerCase();
  if (bMember.startsWith("@")) {
    // A domain in B is only contained by the exact same domain in A. An email
    // list (more restrictive) can never contain a whole domain.
    return aMembers.some((aMember) => aMember.startsWith("@") && aMember.toLowerCase() === bMemberLower);
  }
  // An email in B is contained by a matching domain or the exact email in A.
  return aMembers.some((aMember) => {
    const aMemberLower = aMember.toLowerCase();
    if (aMember.startsWith("@")) return bMemberLower.endsWith(aMemberLower);
    return aMemberLower === bMemberLower;
  });
}
