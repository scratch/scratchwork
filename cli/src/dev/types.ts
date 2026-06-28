import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type * as FileSystem from "@effect/platform/FileSystem";
import type * as HttpPlatform from "@effect/platform/HttpPlatform";
import type * as Path from "@effect/platform/Path";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

export interface DevTarget {
  readonly root: string;
  readonly openPath: string;
}

export interface DevState extends DevTarget {
  readonly reloads: PubSub.PubSub<Uint8Array>;
  readonly loggedMarkdownRoutes: Set<string>;
}

export type DevServices =
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | Path.Path;

export type ScopedDevServices = DevServices | Scope.Scope;
