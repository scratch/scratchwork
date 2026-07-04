/**
 * Verifies Google OAuth ID tokens: RS256 signature against Google's JWKS (fetched and
 * cached per its Cache-Control), plus issuer/audience/expiry/email/nonce claim checks.
 *
 * This module is a deliberate Promise boundary, not an unfinished Effect migration:
 * verification is plain async/await (raw fetch + Web Crypto) wrapped exactly once by
 * Effect.tryPromise in verifyGoogleIdToken, matching the token-exchange fetch in auth.ts.
 * `keyCache` is intentionally process-global: JWKS refreshes are idempotent, so concurrent
 * cold-start misses at worst duplicate one fetch.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { base64UrlToBytes } from "../../../shared/src/encoding/base64";
import { toArrayBuffer } from "../../../shared/src/encoding/bytes";
import { errorMessage } from "../../../shared/src/util/errors";
import { isRecord, parseJson } from "../../../shared/src/util/json";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CLOCK_SKEW_SECONDS = 300;
const FETCH_TIMEOUT_MS = 5_000;
const MIN_CACHE_SECONDS = 60;
const MAX_CACHE_SECONDS = 60 * 60 * 24;

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

/** The JWT header fields checked before verification. */
interface GoogleJwtHeader {
  readonly alg: string;
  readonly kid: string;
  readonly typ?: string;
  readonly crit?: unknown;
}

/** Google's JWKS endpoint response shape. */
interface JwksResponse {
  readonly keys?: ReadonlyArray<JsonWebKey & { readonly kid?: string }>;
}

/** One imported verification key with its cache expiry. */
interface CachedKey {
  readonly key: CryptoKey;
  readonly expiresAt: number;
}

/** Process-global JWKS key cache, keyed `jwksUrl:kid` and shared across requests. */
const keyCache = new Map<string, CachedKey>();

/** Verifies a Google ID token signature and required claims. */
export function verifyGoogleIdToken(
  token: string,
  options: {
    readonly clientId: string;
    readonly expectedNonce?: string;
    readonly jwksUrl?: string;
    readonly nowSeconds?: number;
  },
): Effect.Effect<GoogleIdTokenClaims, GoogleJwtError> {
  return Effect.tryPromise({
    try: async () => {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("ID token must have 3 parts");
      const [encodedHeader, encodedPayload, encodedSignature] = parts;
      const header = decodeJwtJson<GoogleJwtHeader>(encodedHeader);
      if (header.alg !== "RS256") throw new Error("Unsupported ID token algorithm");
      if (typeof header.kid !== "string" || header.kid === "") throw new Error("ID token is missing kid");
      if (header.crit != null) throw new Error("ID token uses unsupported critical headers");

      const payload = decodeJwtJson<GoogleIdTokenClaims>(encodedPayload);
      const signature = base64UrlToBytes(encodedSignature);
      if (signature == null) throw new Error("Invalid ID token signature encoding");

      const key = await getJwksKey(header.kid, options.jwksUrl ?? GOOGLE_JWKS_URL);
      const ok = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        toArrayBuffer(signature),
        toArrayBuffer(new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)),
      );
      if (!ok) throw new Error("Invalid ID token signature");

      validateClaims(payload, options.clientId, options.expectedNonce, options.nowSeconds ?? epochSeconds());
      return payload;
    },
    catch: (cause) => new GoogleJwtError({ message: errorMessage(cause), cause }),
  });
}

/** Decodes one base64url JWT part as JSON. */
function decodeJwtJson<A>(value: string): A {
  const bytes = base64UrlToBytes(value);
  if (bytes == null) throw new Error("Invalid JWT base64url");
  const parsed = parseJson(new TextDecoder().decode(bytes));
  if (!isRecord(parsed)) throw new Error("Invalid JWT JSON");
  return parsed as A;
}

/** Finds a cached Google signing key, refreshing JWKS when needed. */
async function getJwksKey(kid: string, jwksUrl: string): Promise<CryptoKey> {
  const cached = keyCache.get(cacheKey(jwksUrl, kid));
  if (cached != null && cached.expiresAt > Date.now()) return cached.key;

  await refreshJwks(jwksUrl);
  const refreshed = keyCache.get(cacheKey(jwksUrl, kid));
  if (refreshed == null || refreshed.expiresAt <= Date.now()) throw new Error("Unknown Google signing key");
  return refreshed.key;
}

/** Fetches Google's JWKS and imports supported RSA verification keys. */
async function refreshJwks(jwksUrl: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(jwksUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`Could not fetch Google JWKS: ${response.status}`);
    const body = (await response.json().catch(() => null)) as JwksResponse | null;
    if (body == null || !Array.isArray(body.keys)) throw new Error("Invalid Google JWKS response");
    const expiresAt = Date.now() + jwksMaxAgeSeconds(response.headers.get("cache-control")) * 1000;
    evictJwks(jwksUrl);
    await Promise.all(
      body.keys.map(async (jwk) => {
        if (typeof jwk.kid !== "string" || jwk.kid === "" || jwk.kty !== "RSA") return;
        const key = await crypto.subtle.importKey(
          "jwk",
          jwk,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        keyCache.set(cacheKey(jwksUrl, jwk.kid), { key, expiresAt });
      }),
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Removes cached keys for one JWKS URL before storing a refreshed set. */
function evictJwks(jwksUrl: string): void {
  const prefix = `${jwksUrl}:`;
  for (const key of keyCache.keys()) {
    if (key.startsWith(prefix)) keyCache.delete(key);
  }
}

/** Validates issuer, audience, time, email, and nonce claims. */
function validateClaims(
  claims: GoogleIdTokenClaims,
  clientId: string,
  expectedNonce: string | undefined,
  now: number,
): void {
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    throw new Error("Invalid ID token issuer");
  }
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

/** Parses JWKS cache lifetime and clamps it to sane bounds. */
function jwksMaxAgeSeconds(cacheControl: string | null): number {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? "");
  const seconds = match == null ? MIN_CACHE_SECONDS : Number(match[1]);
  return Math.min(Math.max(seconds, MIN_CACHE_SECONDS), MAX_CACHE_SECONDS);
}

/** Builds the process-local cache key for one JWKS key ID. */
function cacheKey(jwksUrl: string, kid: string): string {
  return `${jwksUrl}:${kid}`;
}

/** Returns the current Unix timestamp in seconds. */
function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
