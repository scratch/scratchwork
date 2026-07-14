/**
 * Provider-neutral RS256 JWT machinery shared by google-jwt.ts and cloudflare-jwt.ts:
 * compact-JWT decoding, header checks, JWKS fetch/cache, and signature verification.
 * Claim validation (issuer, audience, expiry, email) stays in each provider module.
 *
 * This module is a deliberate Promise boundary, not an unfinished Effect migration:
 * verification is plain async/await (raw fetch + Web Crypto) wrapped exactly once by
 * Effect.tryPromise in each provider's verify function. `keyCache` is intentionally
 * process-global: JWKS refreshes are idempotent, so concurrent cold-start misses at
 * worst duplicate one fetch.
 */
import * as Either from "effect/Either";
import * as Encoding from "effect/Encoding";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { toArrayBuffer } from "../../../shared/src/encoding/bytes";

/** Tolerated clock difference for exp/nbf/iat claim checks. */
export const CLOCK_SKEW_SECONDS = 300;
const FETCH_TIMEOUT_MS = 5_000;
const MIN_CACHE_SECONDS = 60;
const MAX_CACHE_SECONDS = 60 * 60 * 24;

/** The JWT header fields checked before verification. */
interface JwtHeader {
  readonly alg: string;
  readonly kid: string;
  readonly typ?: string;
  readonly crit?: unknown;
}

/** A JWKS endpoint response shape. */
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

/**
 * Verifies a compact RS256 JWT against the given JWKS endpoint and returns its decoded
 * payload. Checks the header (algorithm, kid, no critical extensions) and the signature
 * only; the caller validates the claims. Throws plain Errors on any failure.
 */
export async function verifyRs256Jwt(token: string, jwksUrl: string): Promise<Record<string, unknown>> {
  const decoded = decodeRs256Jwt(token);
  const key = await getJwksKey(decoded.header.kid, jwksUrl);
  await verifySignature(decoded, key);
  return decoded.payload;
}

/** Verifies a compact RS256 JWT against an already-loaded JWKS document. This is used
 * by local platform simulators, where fetching a provider-owned JWKS endpoint would
 * defeat an otherwise fully offline development environment. */
export async function verifyRs256JwtWithJwks(
  token: string,
  keys: ReadonlyArray<JsonWebKey & { readonly kid?: string }>,
): Promise<Record<string, unknown>> {
  const decoded = decodeRs256Jwt(token);
  const jwk = keys.find((candidate) => candidate.kid === decoded.header.kid && candidate.kty === "RSA");
  if (jwk == null) throw new Error("Unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  await verifySignature(decoded, key);
  return decoded.payload;
}

interface DecodedRs256Jwt {
  readonly header: JwtHeader;
  readonly payload: Record<string, unknown>;
  readonly signed: Uint8Array;
  readonly signature: Uint8Array;
}

/** Parses and validates the provider-neutral parts of one RS256 token. */
function decodeRs256Jwt(token: string): DecodedRs256Jwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Token must have 3 parts");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtJson<JwtHeader>(encodedHeader);
  if (header.alg !== "RS256") throw new Error("Unsupported token algorithm");
  if (typeof header.kid !== "string" || header.kid === "") throw new Error("Token is missing kid");
  if (header.crit != null) throw new Error("Token uses unsupported critical headers");

  const payload = decodeJwtJson<Record<string, unknown>>(encodedPayload);
  const signature = Either.getOrNull(Encoding.decodeBase64Url(encodedSignature));
  if (signature == null) throw new Error("Invalid token signature encoding");
  return {
    header,
    payload,
    signed: new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    signature,
  };
}

/** Checks one decoded token signature with an imported RSA verification key. */
async function verifySignature(decoded: DecodedRs256Jwt, key: CryptoKey): Promise<void> {
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    toArrayBuffer(decoded.signature),
    toArrayBuffer(decoded.signed),
  );
  if (!ok) throw new Error("Invalid token signature");
}

/** Decodes a JSON string (or fails) without running an Effect. */
const parseJsonEither = Schema.decodeUnknownEither(Schema.parseJson());

/** Decodes one base64url JWT part as JSON. */
function decodeJwtJson<A>(value: string): A {
  const bytes = Either.getOrNull(Encoding.decodeBase64Url(value));
  if (bytes == null) throw new Error("Invalid JWT base64url");
  const parsed = Either.getOrNull(parseJsonEither(new TextDecoder().decode(bytes)));
  if (!Predicate.isRecord(parsed)) throw new Error("Invalid JWT JSON");
  return parsed as A;
}

/** Finds a cached signing key, refreshing the JWKS when needed. */
async function getJwksKey(kid: string, jwksUrl: string): Promise<CryptoKey> {
  const cached = keyCache.get(cacheKey(jwksUrl, kid));
  if (cached != null && cached.expiresAt > Date.now()) return cached.key;

  await refreshJwks(jwksUrl);
  const refreshed = keyCache.get(cacheKey(jwksUrl, kid));
  if (refreshed == null || refreshed.expiresAt <= Date.now()) throw new Error("Unknown signing key");
  return refreshed.key;
}

/** Fetches one JWKS document and imports supported RSA verification keys. */
async function refreshJwks(jwksUrl: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(jwksUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`Could not fetch JWKS: ${response.status}`);
    const body = (await response.json().catch(() => null)) as JwksResponse | null;
    if (body == null || !Array.isArray(body.keys)) throw new Error("Invalid JWKS response");
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
