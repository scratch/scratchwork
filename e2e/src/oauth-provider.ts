/*
 * Hermetic OAuth/OIDC test provider: a real HTTP authorization server standing in
 * for Google in the full-loop e2e. Only Google itself is substituted — the server
 * under test reaches it over real loopback HTTP via the SCRATCHWORK_LOCAL_OAUTH_*
 * endpoints (which server config accepts only for loopback deployments).
 *
 * The provider validates Scratchwork's outbound authorization request (client_id,
 * exact redirect URI, state, transaction-specific nonce, PKCE S256 challenge),
 * supports success/denial callbacks, issues one-use codes and RS256-signed ID
 * tokens, rotates keys, and can deliberately emit malformed responses. Its threat
 * cases track RFC 9700 (OAuth 2.0 Security Best Current Practice).
 */

/** The identity the provider asserts in the ID tokens it signs. */
export interface ProviderUser {
  readonly sub: string;
  readonly email: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
  readonly picture?: string;
}

/** The relying-party registration the provider validates requests against. */
export interface OauthProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** The exact redirect URI registered for the client; anything else is rejected. */
  readonly redirectUri: string;
  readonly user: ProviderUser;
}

/** One recorded authorization request, for assertions. */
export interface AuthorizeRequest {
  readonly params: Readonly<Record<string, string>>;
}

interface IssuedCode {
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly scopes: ReadonlySet<string>;
  used: boolean;
}

/** One recorded token-endpoint request, for exchange-order assertions. */
export interface TokenRequest {
  readonly params: Readonly<Record<string, string>>;
}

interface ProviderKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JsonWebKey & { readonly kid: string };
}

/** A running hermetic provider. Mutate `user`, `authorizeResult`, `idTokenClaims`,
 * or `tokenResponseOverride` between logins to steer the next transaction. */
export interface OauthProvider {
  readonly url: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly jwksUrl: string;
  /** Environment variables that point a Scratchwork server at this provider. */
  readonly env: Record<string, string>;
  user: ProviderUser;
  /** "success" issues a code; "deny" sends error=access_denied back. */
  authorizeResult: "success" | "deny";
  /** Extra/overriding claims merged into the next ID token (e.g. wrong nonce or aud). */
  idTokenClaims: Record<string, unknown>;
  /** When set, the token endpoint returns this instead of a valid response. */
  tokenResponseOverride: (() => Response) | null;
  readonly authorizeRequests: AuthorizeRequest[];
  readonly tokenRequests: TokenRequest[];
  /** Adds a new signing key. With retireOld, previous keys leave the JWKS so
   * tokens signed by them stop verifying. */
  rotateKeys(retireOld?: boolean): Promise<void>;
  stop(): void;
}

const PKCE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/** Starts the provider on an ephemeral loopback port. */
export async function startOauthProvider(options: OauthProviderOptions): Promise<OauthProvider> {
  const keys: ProviderKey[] = [await makeProviderKey("kid-1")];
  const codes = new Map<string, IssuedCode>();
  const authorizeRequests: AuthorizeRequest[] = [];
  const tokenRequests: TokenRequest[] = [];
  let kidCounter = 1;

  const provider: Omit<OauthProvider, "url" | "authorizeUrl" | "tokenUrl" | "jwksUrl" | "env" | "stop"> = {
    user: options.user,
    authorizeResult: "success",
    idTokenClaims: {},
    tokenResponseOverride: null,
    authorizeRequests,
    tokenRequests,
    async rotateKeys(retireOld = false) {
      kidCounter += 1;
      const next = await makeProviderKey(`kid-${kidCounter}`);
      if (retireOld) keys.length = 0;
      keys.push(next);
    },
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/authorize" && request.method === "GET") {
        const params = Object.fromEntries(url.searchParams.entries());
        authorizeRequests.push({ params });
        const invalid = validateAuthorizeRequest(params, options);
        if (invalid != null) {
          return new Response(`invalid authorization request: ${invalid}`, { status: 400 });
        }
        const redirect = new URL(params.redirect_uri);
        redirect.searchParams.set("state", params.state);
        if (provider.authorizeResult === "deny") {
          redirect.searchParams.set("error", "access_denied");
        } else {
          const code = crypto.randomUUID();
          codes.set(code, {
            nonce: params.nonce,
            codeChallenge: params.code_challenge,
            scopes: new Set((params.scope ?? "").split(/\s+/).filter(Boolean)),
            used: false,
          });
          redirect.searchParams.set("code", code);
        }
        return Response.redirect(redirect.toString(), 302);
      }

      if (url.pathname === "/token" && request.method === "POST") {
        const body = new URLSearchParams(await request.text());
        tokenRequests.push({ params: Object.fromEntries(body.entries()) });
        if (provider.tokenResponseOverride != null) return provider.tokenResponseOverride();
        const failure = await validateTokenRequest(request, body, codes, options);
        if (failure != null) {
          return Response.json({ error: "invalid_grant", error_description: failure }, { status: 400 });
        }
        const issued = codes.get(body.get("code") ?? "");
        const now = Math.floor(Date.now() / 1000);
        const activeKey = keys[keys.length - 1];
        const idToken = await signProviderJwt(activeKey, {
          iss: "https://accounts.google.com",
          aud: options.clientId,
          azp: options.clientId,
          sub: provider.user.sub,
          ...(issued?.scopes.has("email") === true
            ? { email: provider.user.email, email_verified: provider.user.emailVerified ?? true }
            : {}),
          ...(issued?.scopes.has("profile") !== true || provider.user.name == null ? {} : { name: provider.user.name }),
          ...(issued?.scopes.has("profile") !== true || provider.user.picture == null ? {} : { picture: provider.user.picture }),
          iat: now,
          exp: now + 600,
          nonce: issued?.nonce,
          ...provider.idTokenClaims,
        });
        return Response.json({
          access_token: "hermetic-access-token",
          expires_in: 3600,
          token_type: "Bearer",
          id_token: idToken,
        });
      }

      if (url.pathname === "/jwks" && request.method === "GET") {
        return Response.json(
          { keys: keys.map((key) => key.publicJwk) },
          { headers: { "cache-control": "max-age=60" } },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  return Object.assign(provider, {
    url: base,
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    jwksUrl: `${base}/jwks`,
    env: {
      SCRATCHWORK_LOCAL_OAUTH_AUTHORIZE_URL: `${base}/authorize`,
      SCRATCHWORK_LOCAL_OAUTH_TOKEN_URL: `${base}/token`,
      SCRATCHWORK_LOCAL_OAUTH_JWKS_URL: `${base}/jwks`,
    },
    stop() {
      server.stop(true);
    },
  });
}

/** Validates the outbound authorization request per RFC 9700 expectations. */
function validateAuthorizeRequest(
  params: Record<string, string>,
  options: OauthProviderOptions,
): string | null {
  if (params.response_type !== "code") return `response_type ${params.response_type}`;
  if (params.client_id !== options.clientId) return "unknown client_id";
  if (params.redirect_uri !== options.redirectUri) return `unregistered redirect_uri ${params.redirect_uri}`;
  if (!(params.scope ?? "").split(/\s+/).includes("openid")) return "scope is missing openid";
  if (!params.state) return "missing state";
  if (!params.nonce) return "missing nonce";
  if (params.code_challenge_method !== "S256") return "code_challenge_method must be S256";
  if (!PKCE_PATTERN.test(params.code_challenge ?? "")) return "malformed code_challenge";
  return null;
}

/** Validates the back-channel token request: client auth, one-use code, PKCE proof. */
async function validateTokenRequest(
  request: Request,
  body: URLSearchParams,
  codes: Map<string, IssuedCode>,
  options: OauthProviderOptions,
): Promise<string | null> {
  if (body.get("grant_type") !== "authorization_code") return "grant_type";
  // client_secret_basic only (RFC 6749 §2.3.1), matching what the OIDC conformance
  // suite's basic RP plan enforces. A secret in the body is a regression — reject it.
  if (body.has("client_secret")) return "client_secret must not be sent in the request body";
  const expected = `Basic ${btoa(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`)}`;
  if (request.headers.get("authorization") !== expected) {
    return "client authentication failed";
  }
  if (body.get("redirect_uri") !== options.redirectUri) return "redirect_uri mismatch";
  const issued = codes.get(body.get("code") ?? "");
  if (issued == null) return "unknown code";
  if (issued.used) return "code already used";
  issued.used = true;
  const verifier = body.get("code_verifier") ?? "";
  if (!PKCE_PATTERN.test(verifier)) return "missing code_verifier";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  if (base64Url(new Uint8Array(digest)) !== issued.codeChallenge) return "code_verifier does not match";
  return null;
}

/** Creates one RS256 signing key with its public JWKS entry. */
async function makeProviderKey(kid: string): Promise<ProviderKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" } };
}

/** Signs a compact RS256 JWT with the given provider key. */
async function signProviderJwt(key: ProviderKey, payload: Record<string, unknown>): Promise<string> {
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT" })));
  const body = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(data));
  return `${data}.${base64Url(new Uint8Array(signature))}`;
}

/** Encodes bytes as unpadded base64url. */
function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
