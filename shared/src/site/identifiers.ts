/*
 * Project identifier rules shared by the CLI and server so both sides of the
 * publish protocol agree on what names are valid.
 */

/** Validates project names used in URLs, cookie paths, and DB keys: lowercase letters,
 * digits, and interior ".", "_", "-"; first and last characters alphanumeric; at most
 * 128 chars. Lowercase-only keeps global uniqueness and the case-insensitive
 * reserved-name check in agreement about what "same name" means. Requiring an
 * alphanumeric first character makes every "_"- and "."-prefixed name unclaimable,
 * reserving those prefixes for future server use; the alphanumeric last character keeps
 * clone from creating Windows-hostile "foo." directories. */
export function isSafeProjectIdentifier(value: string): boolean {
  return /^[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$/.test(value);
}

/** Converts arbitrary local directory/file names into safe project identifiers. */
export function slugifyIdentifier(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[-_.]{2,}/g, "-")
    .slice(0, 128)
    .replace(/[._-]+$/, "");
  return isSafeProjectIdentifier(normalized) ? normalized : fallback;
}
