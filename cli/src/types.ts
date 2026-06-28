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

export interface LoginConfig {
  readonly server?: string | null;
  readonly token?: string | null;
}

export interface ServerConfig {
  readonly server?: string | null;
}

export interface ReloadPayload {
  readonly path: string;
  readonly ext: string;
}
