/*
 * Host classification shared by the CLI and server so both sides agree on
 * which hosts count as local development (and may therefore use http).
 */

/**
 * Checks whether a hostname is loopback: localhost, *.localhost (loopback
 * per RFC 6761), IPv4 loopback/unspecified, or IPv6 ::1 in either bare or
 * bracketed form.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}
