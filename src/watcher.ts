/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import chokidar from 'chokidar';
import * as pathlib from 'path';
import {Analyzer} from './analyzer.js';
import {Executor} from './executor.js';
import {Deferred} from './util/deferred.js';
import {scriptReferenceToString} from './script.js';
import {WireitError} from './error.js';

import type {Logger} from './logging/logger.js';
import type {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
} from './script.js';

/**
 *  ┌───────────────┐
 *  | uninitialized | ──────────────────────────────────┐
 *  └───────────────┘                                   |
 *         |                                            |
 *         |  ┌─────────────────────────────────┐       |
 *         |  |  ┌──────────────┐               |       |
 *         ▼  ▼  ▼              |               |       |
 *        ┌───────┐      ┌───────────┐      ┌───────┐   |
 *        | stale | ───► | executing | ───► | fresh |   |
 *        └───────┘      └───────────┘      └───────┘   |
 *          |   ▲            │    │             |       |
 *          |   |            ▼    └──────────┐  |       |
 *          |   |   ┌─────────────────────┐  |  |       |
 *          |   └── | executing-and-stale |  |  |       |
 *          |       └─────────────────────┘  |  |       |
 *          |                │               ▼  ▼       |
 *          |                └──────────► ┌─────────┐   |
 *          └───────────────────────────► | aborted | ◀─┘
 *                                        └─────────┘
 */
type WatcherState =
  | 'uninitialized'
  | 'stale'
  | 'executing'
  | 'executing-and-stale'
  | 'fresh'
  | 'aborted';

/**
 * Watches a script for changes in its input files, and in the input files of
 * its transitive dependencies, and executes all affected scripts when they
 * change.
 *
 * Also watches all related package.json files and reloads script configuration
 * when they change.
 */
export class Watcher {
  private readonly _script: ScriptReference;
  private readonly _logger: Logger;
  private readonly _watchers: Array<chokidar.FSWatcher> = [];

  /** Underlying current state (use {@link _state} to read/write). */
  private __state: WatcherState = 'uninitialized';

  /** Notification that some state has changed. */
  private _stateChange = new Deferred<void>();

  /** Get the current state. */
  private get _state(): WatcherState {
    return this.__state;
  }

  /** Set the current state and notify the main loop. */
  private set _state(state: WatcherState) {
    this.__state = state;
    this._stateChange.resolve();
  }

  constructor(script: ScriptReference, logger: Logger, abort: AbortController) {
    this._script = script;
    this._logger = logger;

    if (abort.signal.aborted) {
      this._state = 'aborted';
    } else {
      abort.signal.addEventListener(
        'abort',
        () => {
          // TODO(aomarks) Aborting should also cause the analyzer and executors to
          // stop if they are running. Currently we only stop after the current
          // build entirely finishes.
          this._state = 'aborted';
        },
        {once: true}
      );
    }
  }

  /**
   * Execute the script, and continue executing it every time a file related to
   * the configured script changes.
   *
   * @returns When the configured abort promise resolves.
   * @throws If an unexpected error occurs during analysis or execution, or if
   * `watch()` is called more than once per instance of `Watcher`.
   */
  async watch(): Promise<void> {
    if (this._state === 'aborted') {
      return;
    }
    if (this._state !== 'uninitialized') {
      // TODO(aomarks) This doesn't throw if we've aborted and watch() was
      // called more than once. Technically it probably should.
      throw new Error('watch() can only be called once per Watcher instance');
    }
    this._state = 'stale';
    try {
      await this._watchLoop();
    } finally {
      // It's important to close all chokidar watchers, because they will
      // prevent the Node program from ever exiting as long as they are active.
      await this._clearWatchers();
    }
  }

  private async _watchLoop(): Promise<void> {
    // Note this function must be factored out of watch() because the
    // `this._state = 'stale'` statement causes `this._state` to be overly
    // narrowed, despite the presense of `await`.
    while (this._state !== 'aborted') {
      if (this._state === 'stale') {
        await this._analyzeAndExecute();
      }
      await this._stateChange.promise;
      this._stateChange = new Deferred();
    }
  }

  /**
   * Perform an analysis and execution.
   */
  private async _analyzeAndExecute(): Promise<void> {
    this._state = 'executing';

    // TODO(aomarks) We only need to reset watchers and re-analyze if a
    // package.json file changed.
    const analyzer = new Analyzer();

    // TODO(aomarks) Add support for recovering from analysis errors. We'll need
    // to track the package.json files that we encountered, and watch them.
    const analysis = await analyzer.analyze(this._script);
    await this._clearWatchers();
    for (const {patterns, cwd} of this._getWatchPathGroups(analysis)) {
      this._watchPatterns(patterns, cwd);
    }

    try {
      const executor = new Executor(this._logger);
      await executor.execute(analysis);
    } catch (error) {
      this._triageErrors(error);
    }

    if (this._state === 'executing') {
      this._state = 'fresh';
    } else if (this._state === 'executing-and-stale') {
      this._state = 'stale';
    }
  }

  /**
   * Handle errors from analysis or execution.
   *
   * Known errors are logged and ignored. They are recoverable because the user
   * can update the config or input files and we'll try again.
   *
   * Other errors throw, aborting the watch process, because they indicate a bug
   * in Wireit, so we can no longer trust the state of the program.
   */
  private _triageErrors(error: unknown): void {
    const errors = error instanceof AggregateError ? error.errors : [error];
    const unexpected = [];
    for (const error of errors) {
      if (error instanceof WireitError) {
        this._logger.log(error.event);
      } else {
        unexpected.push(error);
      }
    }
    if (unexpected.length > 0) {
      if (unexpected.length === 1) {
        throw unexpected[0];
      }
      throw new AggregateError(unexpected);
    }
  }

  /**
   * Start watching some glob patterns.
   */
  private _watchPatterns(patterns: string[], cwd: string): void {
    const watcher = chokidar.watch(patterns, {cwd});
    this._watchers.push(watcher);
    watcher.on('change', this._fileChanged);
  }

  /**
   * One of the paths we are watching has changed.
   */
  private readonly _fileChanged = (): void => {
    // TODO(aomarks) Cache package JSONS, globs, and hashes.
    if (this._state === 'fresh') {
      this._state = 'stale';
    } else if (this._state === 'executing') {
      this._state = 'executing-and-stale';
    }
  };

  /**
   * Shut down all active file watchers and clear the list.
   */
  private async _clearWatchers(): Promise<void> {
    const watchers = this._watchers.splice(0, this._watchers.length);
    await Promise.all(watchers.map((watcher) => watcher.close()));
  }

  /**
   * Walk through a script config and return a list of absolute filesystem paths
   * that we should watch for changes.
   */
  private _getWatchPathGroups(
    script: ScriptConfig
  ): Array<{patterns: string[]; cwd: string}> {
    const packageJsons = new Set<string>();
    const groups: Array<{patterns: string[]; cwd: string}> = [];
    const visited = new Set<ScriptReferenceString>();

    const visit = (script: ScriptConfig) => {
      const key = scriptReferenceToString(script);
      if (visited.has(key)) {
        return;
      }
      visited.add(key);
      packageJsons.add(pathlib.join(script.packageDir, 'package.json'));
      if (script.files !== undefined) {
        // TODO(aomarks) We could optimize to create fewer watchers, but we have
        // to be careful to deal with "!"-prefixed negation entries, because
        // those negations only apply to the previous entries **in that specific
        // "files" array**. A simple solution could be that if a "files" array
        // has any "!"-prefixed entry, then it gets its own watcher, otherwise
        // we can group watchers by packageDir.
        groups.push({patterns: script.files, cwd: script.packageDir});
      }
      for (const dependency of script.dependencies) {
        visit(dependency);
      }
    };

    visit(script);
    groups.push({
      // The package.json group is already resolved to absolute paths, so cwd is
      // arbitrary.
      cwd: process.cwd(),
      patterns: [...packageJsons],
    });
    return groups;
  }
}
