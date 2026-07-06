/*
 * Config objects the CLI command graph in index.ts passes to the handlers in
 * commands/*. Required fields are guaranteed by @effect/cli defaults; optional
 * fields are flags the user may omit entirely.
 */

/** `scratchwork dev` options. */
export interface DevConfig {
  readonly path: string;
  readonly port: number;
  readonly verbose: boolean;
}

/** Commands that take only a target path (`example`, `stream`). */
export interface PathConfig {
  readonly path: string;
}

/** `scratchwork template` options. */
export interface TemplateConfig {
  readonly file: string;
}

/** `scratchwork publish` options. */
export interface PublishConfig {
  readonly path: string;
  readonly server?: string;
  readonly project?: string;
  readonly visibility?: string;
}

/** `scratchwork login` options. */
export interface LoginConfig {
  readonly server?: string;
}

/** Commands addressed to a server as a whole (`me`, `projects`). */
export interface ServerConfig {
  readonly server?: string;
}

/** Commands addressed to one project (`info`, `unpublish`, `delete`). */
export interface ProjectRefConfig {
  readonly pathOrUrl: string;
  readonly server?: string;
  readonly project?: string;
}

/** `scratchwork clone` options. */
export interface CloneConfig {
  readonly pathOrUrl: string;
}
