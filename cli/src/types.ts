export type AuthType = "api_key" | "session" | "bearer";

export interface Auth {
  readonly token: string;
  readonly type: AuthType;
  readonly cfToken?: string;
}

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  readonly slug?: string;
}

export interface ProjectConfig {
  readonly id?: string;
  readonly name?: string;
  readonly server?: string;
}

export interface ApiContext {
  readonly serverUrl: string;
  readonly auth: Auth | null;
}

export interface PublishFile {
  readonly path: string;
  readonly data: Uint8Array;
}

export interface PublishBuildResult {
  readonly files: ReadonlyArray<PublishFile>;
  readonly stats: {
    readonly fileCount: number;
    readonly totalBytes: number;
  };
}

export interface DeployResult {
  readonly id: string;
  readonly name?: string;
  readonly created?: boolean;
  readonly version?: string | number;
  readonly url: string;
  readonly byId?: string;
}

export interface WhoamiResult {
  readonly mode?: string;
  readonly authRequired: boolean;
  readonly authenticated: boolean;
  readonly user?: User;
}

export interface CallbackResult {
  readonly token: string;
  readonly cfToken?: string;
}

export interface TokenRecord {
  readonly id: string;
  readonly prefix: string;
  readonly name?: string;
  readonly expires_at?: string;
}

export interface ShareTokenRecord {
  readonly id: string;
  readonly name?: string;
  readonly duration: string;
  readonly expires_at: string;
  readonly is_active?: boolean;
  readonly is_revoked?: boolean;
}

export interface DevConfig {
  readonly path?: string;
  readonly port?: number;
  readonly verbose?: boolean;
}

export interface PathConfig {
  readonly path?: string;
}

export interface TemplateConfig {
  readonly file?: string;
}

export interface PublishConfig {
  readonly path?: string;
  readonly server?: string | null;
  readonly name?: string | null;
  readonly visibility?: string | null;
  readonly unlisted?: boolean;
  readonly private?: boolean;
  readonly noOpen?: boolean;
  readonly dryRun?: boolean;
}

export interface LoginConfig {
  readonly server?: string | null;
  readonly token?: string | null;
}

export interface ServerConfig {
  readonly server?: string | null;
}

export interface TokenCreateConfig extends ServerConfig {
  readonly name: string;
  readonly expires?: number | null;
}

export interface TokenIdConfig extends ServerConfig {
  readonly id: string;
}

export interface TokenUseConfig extends ServerConfig {
  readonly token: string;
}

export interface ShareProjectConfig extends ServerConfig {
  readonly project?: string | null;
}

export interface ShareCreateConfig extends ShareProjectConfig {
  readonly name?: string | null;
  readonly duration?: string;
}

export interface ShareRevokeConfig extends ShareProjectConfig {
  readonly id: string;
}

export interface ReloadPayload {
  readonly path: string;
  readonly ext: string;
}
