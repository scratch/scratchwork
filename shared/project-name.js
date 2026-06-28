/*
 * Project-name + page-path rules — pure, dependency-free logic shared by the
 * server (validation, content routing) and the CLI (publish). Ported from the
 * reference scratch implementation (shared/src/project.ts).
 *
 * A project's public URL is /<owner-slug>/<project-name>/. The name is the
 * URL-facing identity, so it is constrained to a safe, lowercase slug and a set
 * of reserved words is rejected (including the host labels scratchwork uses for
 * its own routes, so a project can never shadow /api, /auth, the app/pages
 * subdomains, etc.).
 */

export const PROJECT_NAME_REGEX = /^[a-z][a-z0-9-]{2,62}$/;

// Reserved: the reference's base set plus scratchwork's own reserved host
// labels and top-level app routes, so a project name can't collide with them.
export const RESERVED_NAMES = [
  "api",
  "auth",
  "admin",
  "www",
  "app",
  "help",
  "support",
  "static",
  "assets",
  "cdn",
  "files",
  "upload",
  "download",
  "pages",
  "cli-login",
  "device",
  "device-success",
  "error",
  "favicon.ico",
  "install.sh",
];

/**
 * Validate a project name. Returns { valid, error? }.
 */
export function validateProjectName(name) {
  if (!PROJECT_NAME_REGEX.test(name)) {
    return {
      valid: false,
      error:
        "Project name must be 3-63 characters, lowercase letters, numbers, and hyphens, starting with a letter",
    };
  }
  if (RESERVED_NAMES.includes(name)) {
    return { valid: false, error: "This project name is reserved" };
  }
  return { valid: true };
}

// "pete" from "pete@ycombinator.com" (lowercased). null if not an email.
export function getEmailLocalPart(email) {
  const at = String(email).indexOf("@");
  if (at === -1) return null;
  return String(email).substring(0, at).toLowerCase();
}

// "ycombinator.com" from "pete@ycombinator.com". null if malformed.
export function getEmailDomain(email) {
  const parts = String(email).split("@");
  if (parts.length !== 2) return null;
  return parts[1].toLowerCase();
}

/**
 * Parse a content-domain path into { ownerIdentifier, projectName, filePath }.
 * Path format: /<owner-identifier>/<project-name>/<file-path>. Returns null if
 * there aren't at least two non-empty segments. filePath is "" for the root.
 */
export function parsePagePath(pathname) {
  const parts = pathname.slice(1).split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return {
    ownerIdentifier: parts[0],
    projectName: parts[1],
    filePath: parts.slice(2).join("/") || "",
  };
}
