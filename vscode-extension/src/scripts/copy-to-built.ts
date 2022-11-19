/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';

// We want to be deliberate about the files that are included in the extension.
// This is also working around what looks like a bug in a combination of
// npm workspaces, vsce, and npm starting at some version >8.12.2 and <=8.5.0
// which causes issues with the current working directory when running scripts
// in a workspace.
// TODO(rictic): repro and file that bug

fs.mkdirSync('built', {recursive: true});
fs.copyFileSync('../schema.json', './built/schema.json');
fs.copyFileSync('../LICENSE', './built/LICENSE');
fs.copyFileSync('./README.md', './built/README.md');
fs.copyFileSync('./CHANGELOG.md', './built/CHANGELOG.md');
