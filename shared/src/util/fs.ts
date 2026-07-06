/*
 * Filesystem containment math shared by code that maps untrusted relative
 * keys onto a directory root (the server's local object storage and the CLI
 * dev server's site files).
 */

/** Checks whether an already-resolved absolute path is the root itself or inside it. */
export function isWithinRoot(absolute: string, root: string, separator: string): boolean {
  return absolute === root || absolute.startsWith(root + separator);
}
