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

/** `scratchwork publish` options. `isPublic` stays undefined when neither --public nor
 * --private is passed, letting saved config or the server decide. */
export interface PublishConfig {
  readonly path: string;
  readonly server?: string;
  readonly project?: string;
  readonly isPublic?: boolean;
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

/** `scratchwork share` / `scratchwork revoke` options. Positional args mix grant
 * targets (emails, @domain groups) with an optional project path or URL. `role` is the
 * permission level share assigns (revoke always strips every role). */
export interface ShareConfig {
  readonly targets: ReadonlyArray<string>;
  readonly server?: string;
  readonly project?: string;
  readonly role?: "read" | "write" | "admin";
}

/** `scratchwork clone` options. */
export interface CloneConfig {
  readonly pathOrUrl: string;
}
