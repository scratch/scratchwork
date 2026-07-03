/*
 * Types shared across the `scratchwork dev` server modules.
 */
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type * as FileSystem from "@effect/platform/FileSystem";
import type * as HttpPlatform from "@effect/platform/HttpPlatform";
import type * as Path from "@effect/platform/Path";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

/** Where the dev server serves from and which route to open in the browser. */
export interface DevTarget {
  readonly root: string;
  readonly openPath: string;
}

/** Mutable per-session state threaded through the dev server modules. */
export interface DevState extends DevTarget {
  /** Raw SSE frames fanned out to every connected live-reload browser stream. */
  readonly reloads: PubSub.PubSub<Uint8Array>;
  /** Markdown routes already logged, so render diagnostics print once per route. */
  readonly loggedMarkdownRoutes: Set<string>;
}

/** One file-change event sent to browsers, with its extension sans dot. */
export interface ReloadPayload {
  readonly path: string;
  readonly ext: string;
}

/** Platform services the dev command requires. */
export type DevServices =
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | Path.Path;

/** DevServices plus the scope that owns the server, watcher, and heartbeat. */
export type ScopedDevServices = DevServices | Scope.Scope;
