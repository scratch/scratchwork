import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type AccessGroup } from "./access.ts";
/** An environment-variable map from any platform (process.env, Worker vars, Lambda env). */
export type EnvVars = Readonly<Record<string, string | undefined>>;
/** Parsed server configuration. */
export interface ServerConfigShape {
    readonly port: number;
    /** Public origin of the app host (auth routes and API), when configured. */
    readonly appUrl?: string;
    /** Public origin of the content host (published sites), when configured. */
    readonly contentUrl?: string;
    /** Origins served from the homepage project (first is canonical, the rest 308 to it).
     * Empty when the server has no homepage. */
    readonly homepageUrls: ReadonlyArray<string>;
    /** Name of the project served on the homepage origins; set iff homepageUrls is non-empty. */
    readonly homepageProject?: string;
    /** false: no project may be public — existing public projects read as private. */
    readonly allowPublicProjects: boolean;
    /** When non-empty, share grants must fall inside these domains; grants outside them
     * stop conferring access. */
    readonly allowedShareDomains: ReadonlySet<string>;
    /** true: publishers choose globally-unique project names (first-writer-wins).
     * false: the server assigns a random slug on first publish. */
    readonly usersCanSetProjectNames: boolean;
    readonly auth: AuthConfig;
}
/** Session-signing and allow-list settings shared by every auth mode. */
export interface AuthConfigCommon {
    readonly sessionSecret: string;
    readonly allowedUsers: AccessGroup;
    readonly sessionTtlSeconds: number;
}
/** Authorization-server endpoints used by the OAuth login flow. Overridable only
 * by the loopback-gated local test configuration; production always uses Google's. */
export interface OAuthProviderEndpoints {
    readonly authorizeUrl: string;
    readonly tokenUrl: string;
    readonly jwksUrl: string;
}
/** Built-in Google OAuth: the server runs the login flow itself. */
export interface OAuthAuthConfig extends AuthConfigCommon {
    readonly mode: "oauth";
    readonly clientId: string;
    readonly clientSecret: string;
    /** Provider endpoints supplied only by the hermetic local test provider. */
    readonly localEndpoints?: OAuthProviderEndpoints;
}
/** Cloudflare Access: the server sits behind an Access application that authenticates
 * users at the edge and injects a signed Cf-Access-Jwt-Assertion header. */
export interface CloudflareAccessAuthConfig extends AuthConfigCommon {
    /** Team origin the assertions are issued by, like "https://myteam.cloudflareaccess.com". */
    readonly teamDomain: string;
    /** Audience (AUD) tag of the Access application protecting this server. */
    readonly audience: string;
    /** Public signing keys supplied only by the offline local Access simulator. */
    readonly localJwks?: ReadonlyArray<JsonWebKey & {
        readonly kid?: string;
    }>;
    readonly mode: "cloudflare-access";
}
/** Auth settings. Auth cannot be disabled. */
export type AuthConfig = OAuthAuthConfig | CloudflareAccessAuthConfig;
declare const ServerConfig_base: Context.TagClass<ServerConfig, "@scratchwork/server/Config", ServerConfigShape>;
/** Service tag for server configuration. */
export declare class ServerConfig extends ServerConfig_base {
}
declare const ServerConfigError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ServerConfigError";
} & Readonly<A>;
/** Raised when environment configuration is missing or malformed. */
export declare class ServerConfigError extends ServerConfigError_base<{
    readonly message: string;
}> {
}
/** Builds a ServerConfig layer from an explicit environment map. */
export declare function makeServerConfigLayer(env: EnvVars): Layer.Layer<ServerConfig, ServerConfigError>;
/** Parses all server runtime configuration from environment variables. */
export declare function readServerConfig(env: EnvVars): Effect.Effect<ServerConfigShape, ServerConfigError>;
export {};
