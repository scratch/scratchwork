/**
 * Verifies Cloudflare Access application tokens (the Cf-Access-Jwt-Assertion header the
 * edge injects after authenticating a user): RS256 signature against the team's JWKS via
 * the shared machinery in jwt-rs256.ts, plus issuer/audience/expiry/email claim checks.
 *
 * Only identity assertions carrying an email are accepted; Access service tokens assert a
 * client ID (common_name) instead of a user and are rejected, since every scratchwork
 * authorization decision is keyed by email.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { errorMessage } from "@scratchwork/shared/util/errors";
import { CLOCK_SKEW_SECONDS, verifyRs256Jwt, verifyRs256JwtWithJwks } from "./jwt-rs256.ts";

/** Raised when an Access token fails signature or claim validation. */
export class CloudflareJwtError extends Data.TaggedError("CloudflareJwtError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The Cloudflare Access application-token claims the server reads. */
export interface CloudflareAccessClaims {
  readonly iss: string;
  readonly aud: string | ReadonlyArray<string>;
  readonly sub: string;
  readonly email: string;
  readonly exp: number;
  readonly iat?: number;
  readonly nbf?: number;
  /** Set on service-token assertions instead of email; those are rejected. */
  readonly common_name?: string;
}

/** The JWKS endpoint Cloudflare serves for one Access team origin. */
export function cloudflareJwksUrl(teamDomain: string): string {
  return `${teamDomain}/cdn-cgi/access/certs`;
}

/** Verifies a Cloudflare Access application token signature and required claims. */
export function verifyCloudflareAccessToken(
  token: string,
  options: {
    /** Team origin the token must be issued by, like "https://myteam.cloudflareaccess.com". */
    readonly teamDomain: string;
    /** Audience (AUD) tag of the Access application protecting this server. */
    readonly audience: string;
    readonly jwksUrl?: string;
    /** Preloaded public keys for an offline local Access simulation. Production uses
     * the team JWKS URL and never sets this. */
    readonly jwks?: ReadonlyArray<JsonWebKey & { readonly kid?: string }>;
    readonly nowSeconds?: number;
  },
): Effect.Effect<CloudflareAccessClaims, CloudflareJwtError> {
  return Effect.tryPromise({
    try: async () => {
      const payload = (await (options.jwks == null
        ? verifyRs256Jwt(token, options.jwksUrl ?? cloudflareJwksUrl(options.teamDomain))
        : verifyRs256JwtWithJwks(token, options.jwks))) as unknown as CloudflareAccessClaims;
      validateClaims(payload, options.teamDomain, options.audience, options.nowSeconds ?? epochSeconds());
      return payload;
    },
    catch: (cause) => new CloudflareJwtError({ message: errorMessage(cause), cause }),
  });
}

/** Validates issuer, audience, time, and email claims. */
function validateClaims(
  claims: CloudflareAccessClaims,
  teamDomain: string,
  audience: string,
  now: number,
): void {
  if (claims.iss !== teamDomain) throw new Error("Invalid Access token issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) throw new Error("Invalid Access token audience");
  if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_SECONDS) throw new Error("Expired Access token");
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SECONDS) throw new Error("Access token not active yet");
  if (typeof claims.iat === "number" && claims.iat > now + CLOCK_SKEW_SECONDS) throw new Error("Access token issued in the future");
  if (typeof claims.email !== "string" || claims.email === "") {
    throw new Error("Access token asserts no email (service tokens are not supported)");
  }
}

/** Returns the current Unix timestamp in seconds. */
function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
