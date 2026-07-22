/**
 * The Google identity-provider back-channel: verifies Google OAuth ID tokens (RS256
 * signature against Google's JWKS via the shared machinery in jwt-rs256.ts, plus
 * issuer/audience/expiry/email/nonce claim checks) and POSTs the authorization-code
 * grant to the token endpoint. Together with jwt-rs256.ts this is a deliberate
 * Promise boundary under invariant 1 (raw fetch + Web Crypto); auth.ts wraps each
 * entry point exactly once with Effect.tryPromise.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { errorMessage } from "@scratchwork/shared/util/errors";
import { CLOCK_SKEW_SECONDS, verifyRs256Jwt } from "./jwt-rs256.ts";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/** Raised when an ID token fails signature or claim validation. */
export class GoogleJwtError extends Data.TaggedError("GoogleJwtError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The Google ID-token claims the server reads. */
export interface GoogleIdTokenClaims {
  readonly iss: string;
  readonly aud: string | ReadonlyArray<string>;
  readonly azp?: string;
  readonly sub: string;
  readonly email: string;
  readonly email_verified: boolean;
  readonly exp: number;
  readonly iat?: number;
  readonly nbf?: number;
  readonly nonce?: string;
  readonly name?: string;
  readonly picture?: string;
}

/** Verifies a Google ID token signature and required claims. */
export function verifyGoogleIdToken(
  token: string,
  options: {
    readonly clientId: string;
    readonly expectedNonce?: string;
    readonly jwksUrl?: string;
    /** Accepted `iss` claim when a local test provider issues under its own URL
     * (loopback-gated config); Google's issuers when absent. */
    readonly expectedIssuer?: string;
    readonly nowSeconds?: number;
  },
): Effect.Effect<GoogleIdTokenClaims, GoogleJwtError> {
  return Effect.tryPromise({
    try: async () => {
      const payload = (await verifyRs256Jwt(token, options.jwksUrl ?? GOOGLE_JWKS_URL)) as unknown as GoogleIdTokenClaims;
      validateClaims(payload, options.clientId, options.expectedNonce, options.expectedIssuer, options.nowSeconds ?? epochSeconds());
      return payload;
    },
    catch: (cause) => new GoogleJwtError({ message: errorMessage(cause), cause }),
  });
}

/** Google's token-endpoint response shape, as much of it as the exchange needs —
 * decoded tolerantly, so extra fields are ignored and a malformed body is null. */
const GoogleTokenResponseSchema = Schema.Struct({
  id_token: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

export type GoogleTokenResponse = typeof GoogleTokenResponseSchema.Type;

const decodeTokenResponse = Schema.decodeUnknownOption(GoogleTokenResponseSchema);

/** POSTs an authorization-code grant (with its PKCE verifier) to the token endpoint —
 * Google's, or the loopback-gated local test provider's. Client authentication is
 * client_secret_basic (RFC 6749 §2.3.1: credentials form-urlencoded, then Basic) —
 * the scheme servers are required to support, and the one the OIDC conformance
 * suite's basic RP plan validates. Network and JSON failures surface as a thrown
 * error or a null body for the caller to translate. */
export async function postAuthorizationCodeGrant(
  tokenUrl: string,
  params: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  },
): Promise<{ readonly ok: boolean; readonly json: GoogleTokenResponse | null }> {
  const body = new URLSearchParams({
    code: params.code,
    code_verifier: params.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
  });
  const credentials = `${encodeURIComponent(params.clientId)}:${encodeURIComponent(params.clientSecret)}`;
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // btoa is safe here: the percent-encoded credentials are pure ASCII. It is
      // also the encoder available on every platform this core runs on.
      authorization: `Basic ${btoa(credentials)}`,
    },
    body,
  });
  const responseBody: unknown = await response.json().catch(() => null);
  return { ok: response.ok, json: Option.getOrNull(decodeTokenResponse(responseBody)) };
}

/** Validates issuer, audience, time, email, and nonce claims. */
function validateClaims(
  claims: GoogleIdTokenClaims,
  clientId: string,
  expectedNonce: string | undefined,
  expectedIssuer: string | undefined,
  now: number,
): void {
  const validIssuer = expectedIssuer == null
    ? claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com"
    : claims.iss === expectedIssuer;
  if (!validIssuer) throw new Error("Invalid ID token issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientId)) throw new Error("Invalid ID token audience");
  if (audiences.length > 1 && claims.azp !== clientId) throw new Error("Invalid ID token authorized party");
  if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_SECONDS) throw new Error("Expired ID token");
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SECONDS) throw new Error("ID token not active yet");
  if (typeof claims.iat === "number" && claims.iat > now + CLOCK_SKEW_SECONDS) throw new Error("ID token issued in the future");
  if (typeof claims.sub !== "string" || claims.sub === "") throw new Error("ID token is missing subject");
  if (typeof claims.email !== "string" || claims.email === "") throw new Error("ID token is missing email");
  if (claims.email_verified !== true) throw new Error("Google email is not verified");
  if (expectedNonce != null && claims.nonce !== expectedNonce) throw new Error("Invalid ID token nonce");
}

/** Returns the current Unix timestamp in seconds. */
function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
