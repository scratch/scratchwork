/*
 * Workspace/project identifier rules shared by the CLI and server so both
 * sides of the publish protocol agree on what names are valid.
 */

/** Validates workspace/project ids used in URLs and DB keys. */
export function safeProjectIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

/** Converts arbitrary local directory/file names into safe project identifiers. */
export function slugifyIdentifier(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[-_.]{2,}/g, "-")
    .slice(0, 128);
  return safeProjectIdentifier(normalized) ? normalized : fallback;
}

/** Converts an email into the default personal workspace name. */
export function workspaceFromEmail(email: string): string {
  const username = email.split("@", 1)[0]?.toLowerCase() ?? "user";
  return safeProjectIdentifier(username) ? username : slugifyIdentifier(username, "user");
}
