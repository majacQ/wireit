/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Result} from '../error.js';
import {AsyncCache} from './async-cache.js';
import {PackageJson} from './package-json.js';
import * as pathlib from 'path';
import * as fs from 'fs/promises';
import {parseTree} from './ast.js';

export const astKey = Symbol('ast');

export interface FileSystem {
  readFile(path: string, options: 'utf8'): Promise<string>;
}

/**
 * Reads package.json files and caches them.
 */
export class CachingPackageJsonReader {
  private readonly _cache = new AsyncCache<string, Result<PackageJson>>();
  private readonly _fs;
  constructor(filesystem: FileSystem = fs) {
    this._fs = filesystem;
  }

  async read(packageDir: string): Promise<Result<PackageJson>> {
    return this._cache.getOrCompute(packageDir, async () => {
      const path = pathlib.resolve(packageDir, 'package.json');
      let contents;
      try {
        contents = await this._fs.readFile(path, 'utf8');
      } catch (error) {
        if ((error as {code?: string}).code === 'ENOENT') {
          return {
            ok: false,
            error: {
              type: 'failure',
              reason: 'missing-package-json',
              script: {packageDir},
            },
          };
        }
        throw error;
      }
      const astResult = parseTree(path, contents);
      if (!astResult.ok) {
        return astResult;
      }
      const packageJsonFile = new PackageJson(
        {contents, path},
        astResult.value
      );
      return {ok: true, value: packageJsonFile};
    });
  }

  async *getFailures() {
    const values = await Promise.all([...this._cache.values]);
    for (const result of values) {
      if (!result.ok) {
        yield result.error;
        continue;
      }
      const packageJson = result.value;
      yield* packageJson.failures;
    }
  }
}
