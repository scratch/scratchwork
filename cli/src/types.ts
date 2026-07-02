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
  readonly workspace?: string;
  readonly project?: string;
  readonly visibility?: string;
}

export interface LoginConfig {
  readonly server?: string;
}

export interface ServerConfig {
  readonly server?: string;
}

export interface ProjectRefConfig {
  readonly pathOrUrl?: string;
  readonly server?: string;
  readonly workspace?: string;
  readonly project?: string;
}

export interface CloneConfig {
  readonly pathOrUrl?: string;
}

export interface ReloadPayload {
  readonly path: string;
  readonly ext: string;
}
