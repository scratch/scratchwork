/**
 * Local-only Worker entry point that simulates the identity assertion Cloudflare Access
 * adds at the edge, then delegates to the production Worker. Wrangler supplies local R2
 * and D1 bindings; this wrapper supplies the one edge feature Miniflare cannot emulate.
 */
import * as Encoding from "effect/Encoding";
import { toArrayBuffer } from "@scratchwork/shared/encoding/bytes";
import worker from "./worker.ts";

interface LocalAccessEnv extends Record<string, unknown> {
  readonly SCRATCHWORK_LOCAL_CF_ACCESS_PRIVATE_JWK: string;
  readonly SCRATCHWORK_LOCAL_CF_ACCESS_EMAIL: string;
  readonly SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN: string;
  readonly SCRATCHWORK_CF_ACCESS_AUD: string;
}

interface ExecutionContextBinding {
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly passThroughOnException: () => void;
}

const KID = "scratchwork-local-access";
const importedKeys = new Map<string, Promise<CryptoKey>>();

export default {
  async fetch(request: Request, env: LocalAccessEnv, context: ExecutionContextBinding): Promise<Response> {
    try {
      // In production this endpoint belongs to Cloudflare's edge. Locally there is no
      // persistent Access browser session to clear, so returning home models the next
      // request beginning a fresh simulated session.
      if (new URL(request.url).pathname === "/cdn-cgi/access/logout") {
        return Response.redirect(new URL("/", request.url), 302);
      }
      const pathname = new URL(request.url).pathname;
      const headers = new Headers(request.headers);
      // Production Access must bypass this one PKCE exchange path so a first login
      // does not need the credential it is trying to acquire. Model that edge rule
      // locally; every other route receives an authoritative Access assertion.
      if (!shouldInjectAccessAssertion(pathname)) {
        headers.delete("Cf-Access-Jwt-Assertion");
      } else {
        const assertion = await issueLocalAccessAssertion(env);
        // Access owns this header at the edge. Always overwrite a client value.
        headers.set("Cf-Access-Jwt-Assertion", assertion);
      }
      return worker.fetch(new Request(request, { headers }), env as never, context);
    } catch (error) {
      console.error("scratchwork local Access simulator: unhandled error", error);
      return new Response(JSON.stringify({ error: "Local Cloudflare Access simulation failed" }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  },
};

/** Mirrors the production Access policy's one deliberately bypassed route. */
export function shouldInjectAccessAssertion(pathname: string): boolean {
  return pathname !== "/auth/cli/token";
}

/** Issues one short-lived, Cloudflare-shaped application token for the configured local
 * identity. The production verifier still checks its RS256 signature and all claims. */
export async function issueLocalAccessAssertion(env: LocalAccessEnv, now = epochSeconds()): Promise<string> {
  const header = encodeJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encodeJson({
    iss: normalizedTeamDomain(env.SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN),
    aud: [env.SCRATCHWORK_CF_ACCESS_AUD],
    sub: `local:${env.SCRATCHWORK_LOCAL_CF_ACCESS_EMAIL.toLowerCase()}`,
    email: env.SCRATCHWORK_LOCAL_CF_ACCESS_EMAIL.toLowerCase(),
    iat: now,
    nbf: now,
    exp: now + 60 * 60,
    type: "app",
  });
  const signed = `${header}.${payload}`;
  const key = await localPrivateKey(env.SCRATCHWORK_LOCAL_CF_ACCESS_PRIVATE_JWK);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    toArrayBuffer(new TextEncoder().encode(signed)),
  );
  return `${signed}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`;
}

/** Imports and caches the generated private key for the life of the local isolate. */
function localPrivateKey(value: string): Promise<CryptoKey> {
  const cached = importedKeys.get(value);
  if (cached != null) return cached;
  const imported = Promise.resolve().then(() =>
    crypto.subtle.importKey(
      "jwk",
      JSON.parse(value) as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    )
  );
  importedKeys.set(value, imported);
  return imported;
}

/** Mirrors server config's normalization for the generated JWT issuer. */
function normalizedTeamDomain(value: string): string {
  const host = value.toLowerCase().replace(/^https:\/\//, "").replace(/[/?#].*$/, "");
  return `https://${host.includes(".") ? host : `${host}.cloudflareaccess.com`}`;
}

function encodeJson(value: unknown): string {
  return Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
