/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  JsonFile,
  ArrayNode,
  JsonAstNode,
  NamedAstNode,
} from './util/ast.js';
import type {Failure} from './event.js';
import type {PotentiallyValidScriptConfig} from './analyzer.js';

/**
 * The location on disk of an npm package.
 */
export interface PackageReference {
  /** Absolute path to an npm package directory. */
  packageDir: string;
}

/**
 * The name and package location of a script.
 */
export interface ScriptReference extends PackageReference {
  /** A concrete script name (no ./ or $WORKSPACES etc.) */
  name: string;
}

/**
 * A script with a defined command.
 */
export interface ScriptReferenceWithCommand extends ScriptReference {
  /**
   * The shell command to execute.
   */
  command: JsonAstNode<string>;

  /**
   * Extra arguments to pass to the command.
   */
  extraArgs: string[] | undefined;
}

export interface Dependency<
  Config extends PotentiallyValidScriptConfig = ScriptConfig
> {
  config: Config;
  specifier: JsonAstNode<string>;
  cascade: boolean;
}

export type ScriptConfig =
  | NoCommandScriptConfig
  | StandardScriptConfig
  | ServiceScriptConfig;

/**
 * A script that doesn't run or produce anything. A pass-through for
 * dependencies and/or files.
 */
export interface NoCommandScriptConfig extends BaseScriptConfig {
  command: undefined;
  extraArgs: undefined;
  service: undefined;
}

/**
 * A script with a command that exits by itself.
 */
export interface StandardScriptConfig
  extends BaseScriptConfig,
    ScriptReferenceWithCommand {
  service: undefined;
}

export type ServiceConfig = {
  readyWhen: {
    lineMatches: RegExp | undefined;
  };
};

/**
 * A service script.
 */
export interface ServiceScriptConfig
  extends BaseScriptConfig,
    ScriptReferenceWithCommand {
  service: ServiceConfig;

  /**
   * Whether this service persists beyond the initial execution phase.
   *
   * When true, this service will keep running until the user exits wireit, or
   * until its fingerprint changes in watch mode, requiring a restart.
   *
   * When false, this service will start only if it is needed by a standard
   * script, and will stop when that dependent is done. We call these scripts
   * "ephemeral".
   *
   * So, this is true when there is a path from the entrypoint script to the
   * service, which does not pass through a standard script.
   *
   * Example:
   *
   *                      start
   *                   (no-command)
   *                    /        \
   *                   ▼          ▼
   *             serve:api      serve:static
   *  (persistent service)      (persistent service)
   *          |                          |
   *          ▼                          ▼
   *      serve:db                   build:assets
   *  (persistent service)            (standard)
   *                                     |
   *                                     ▼
   *                             serve:playwright
   *                            (ephemeral service)
   */
  isPersistent: boolean;

  /**
   * Scripts that depend on this service.
   */
  serviceConsumers: Array<ServiceScriptConfig | StandardScriptConfig>;
}

/**
 * The name and location of a script, along with its full configuration.
 */
interface BaseScriptConfig extends ScriptReference {
  state: 'valid';

  /**
   * Scripts that must run before this one.
   *
   * Note that the {@link Analyzer} returns dependencies sorted by package
   * directory + script name, but the {@link Executor} then randomizes the order
   * during execution.
   */
  dependencies: Array<Dependency>;

  /**
   * The services that need to be started before we can run.
   */
  services: Array<ServiceScriptConfig>;

  /**
   * Input file globs for this script.
   *
   * If undefined, the input files are unknown (meaning the script cannot safely
   * be cached). If defined but empty, there are no input files (meaning the
   * script can safely be cached).
   */
  files: ArrayNode<string> | undefined;

  /**
   * Output file globs for this script.
   */
  output: ArrayNode<string> | undefined;

  /**
   * When to clean output:
   *
   * - true: Before the script executes, and before restoring from cache.
   * - false: Before restoring from cache.
   * - "if-file-deleted": If an input file has been deleted, and before restoring from
   *   cache.
   */
  clean: boolean | 'if-file-deleted';

  /**
   * Whether the script should run in service mode.
   */
  service: ServiceConfig | undefined;

  /**
   * The command string in the scripts section. i.e.:
   *
   * ```json
   *   "scripts": {
   *     "build": "tsc"
   *              ~~~~~
   *   }
   * ```
   */
  scriptAstNode: NamedAstNode<string>;

  /**
   * The entire config in the wireit section. i.e.:
   *
   * ```json
   *   "build": {
   *            ~
   *     "command": "tsc"
   *   ~~~~~~~~~~~~~~~~~~
   *   }
   *   ~
   * ```
   */
  configAstNode: NamedAstNode | undefined;

  /** The parsed JSON file that declared this script. */
  declaringFile: JsonFile;
  failures: Failure[];
}

/**
 * Convert a {@link ScriptReference} to a string that can be used as a key in a
 * Set, Map, etc.
 */
export const scriptReferenceToString = ({
  packageDir,
  name,
}: ScriptReference): ScriptReferenceString =>
  JSON.stringify([packageDir, name]) as ScriptReferenceString;

/**
 * Inverse of {@link scriptReferenceToString}.
 */
export const stringToScriptReference = (
  str: ScriptReferenceString
): ScriptReference => {
  const [packageDir, name] = JSON.parse(str) as [string, string];
  return {packageDir, name};
};

/**
 * Brand that ensures {@link stringToScriptReference} only takes strings that
 * were returned by {@link scriptReferenceToString}.
 */
export type ScriptReferenceString = string & {
  __ScriptReferenceStringBrand__: never;
};
