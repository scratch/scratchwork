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
  readonly server?: string;
  readonly slug?: string;
  readonly token?: string;
}

export interface ReloadPayload {
  readonly path: string;
  readonly ext: string;
}
