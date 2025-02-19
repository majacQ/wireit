/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';
import {IS_WINDOWS} from './util/windows.js';

const test = suite<{rig: WireitTestRig}>();

test.before.each(async (ctx) => {
  try {
    ctx.rig = new WireitTestRig();
    await ctx.rig.setup();
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu before error', error);
    process.exit(1);
  }
});

test.after.each(async (ctx) => {
  try {
    await ctx.rig.cleanup();
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu after error', error);
    process.exit(1);
  }
});

test(
  'rig commands exit and emit stdout/stderr as requested',
  timeout(async ({rig}) => {
    // Test 2 different simultaneous commands, one with two simultaneous
    // invocations.
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();

    const execA1 = rig.exec(cmdA.command);
    const invA1 = await cmdA.nextInvocation();
    const execA2 = rig.exec(cmdA.command);
    const invA2 = await cmdA.nextInvocation();
    const execB1 = rig.exec(cmdB.command);
    const invB1 = await cmdB.nextInvocation();

    invA1.stdout('a1 stdout');
    invA1.stderr('a1 stderr');
    invA2.stdout('a2 stdout');
    invA2.stderr('a2 stderr');
    invB1.stdout('b1 stdout');
    invB1.stderr('b1 stderr');

    invA1.exit(42);
    invA2.exit(43);
    invB1.exit(44);

    const resA1 = await execA1.exit;
    const resA2 = await execA2.exit;
    const resB1 = await execB1.exit;

    assert.match(resA1.stdout, 'a1 stdout');
    assert.match(resA1.stderr, 'a1 stderr');
    assert.match(resA2.stdout, 'a2 stdout');
    assert.match(resA2.stderr, 'a2 stderr');
    assert.match(resB1.stdout, 'b1 stdout');
    assert.match(resB1.stderr, 'b1 stderr');

    assert.equal(resA1.code, 42);
    assert.equal(resA2.code, 43);
    assert.equal(resB1.code, 44);
  })
);

test(
  'runs one script that succeeds',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
          },
        },
      },
    });
    const exec = rig.exec('npm run a');

    const invA = await cmdA.nextInvocation();
    invA.stdout('a stdout');
    invA.stderr('a stderr');
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.match(res.stdout, 'a stdout');
    assert.match(res.stderr, 'a stderr');
  })
);

test(
  'runs one script that succeeds from a package sub-directory',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
          },
        },
      },
      // This file is here just to create "subdir".
      'subdir/foo.txt': '',
    });

    // Just like normal npm, when we run "npm run" from a directory that doesn't
    // have a package.json, we should find the nearest package.json up the
    // filesystem hierarchy.
    const exec = rig.exec('npm run a', {cwd: 'subdir'});

    const invA = await cmdA.nextInvocation();
    invA.stdout('a stdout');
    invA.stderr('a stderr');
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.match(res.stdout, 'a stdout');
    assert.match(res.stderr, 'a stderr');
  })
);

test(
  'runs one script that fails',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
          },
        },
      },
    });
    const exec = rig.exec('npm run a');

    const invA = await cmdA.nextInvocation();
    invA.stdout('a stdout');
    invA.stderr('a stderr');
    invA.exit(1);

    const res = await exec.exit;
    assert.equal(res.code, 1);
    assert.equal(cmdA.numInvocations, 1);
    assert.match(res.stdout, 'a stdout');
    assert.match(res.stderr, 'a stderr');
  })
);

test(
  'dependency chain in one package that succeeds',
  timeout(async ({rig}) => {
    // a --> b --> c
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    const cmdC = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['b'],
          },
          b: {
            command: cmdB.command,
            dependencies: ['c'],
          },
          c: {
            command: cmdC.command,
          },
        },
      },
    });
    const exec = rig.exec('npm run a');

    const invC = await cmdC.nextInvocation();
    invC.stdout('c stdout');
    invC.stderr('c stderr');
    invC.exit(0);

    const invB = await cmdB.nextInvocation();
    invB.stdout('b stdout');
    invB.stderr('b stderr');
    invB.exit(0);

    const invA = await cmdA.nextInvocation();
    invA.stdout('a stdout');
    invA.stderr('a stderr');
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.equal(cmdB.numInvocations, 1);
    assert.equal(cmdC.numInvocations, 1);
    assert.match(res.stdout, /c stdout.*b stdout.*a stdout/s);
    assert.match(res.stderr, /c stderr.*b stderr.*a stderr/s);
  })
);

test(
  'dependency chain with vanilla npm script at the end',
  timeout(async ({rig}) => {
    // a --> b --> c
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    const cmdC = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          // wireit scripts can depend on non-wireit scripts.
          c: cmdC.command,
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['b'],
          },
          b: {
            command: cmdB.command,
            dependencies: ['c'],
          },
        },
      },
    });
    const exec = rig.exec('npm run a');

    const invC = await cmdC.nextInvocation();
    invC.stdout('c stdout');
    invC.stderr('c stderr');
    invC.exit(0);

    const invB = await cmdB.nextInvocation();
    invB.stdout('b stdout');
    invB.stderr('b stderr');
    invB.exit(0);

    const invA = await cmdA.nextInvocation();
    invA.stdout('a stdout');
    invA.stderr('a stderr');
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.equal(cmdB.numInvocations, 1);
    assert.equal(cmdC.numInvocations, 1);
    assert.match(res.stdout, /c stdout.*b stdout.*a stdout/s);
    assert.match(res.stderr, /c stderr.*b stderr.*a stderr/s);
  })
);

test(
  'dependency chain in one package that fails in the middle',
  timeout(async ({rig}) => {
    // a --> b* --> c
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    const cmdC = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['b'],
          },
          b: {
            command: cmdB.command,
            dependencies: ['c'],
          },
          c: {
            command: cmdC.command,
          },
        },
      },
    });
    const exec = rig.exec('npm run a');

    const invC = await cmdC.nextInvocation();
    invC.exit(0);

    const invB = await cmdB.nextInvocation();
    invB.exit(42);

    const res = await exec.exit;
    assert.equal(res.code, 1);
    assert.equal(cmdA.numInvocations, 0);
    assert.equal(cmdB.numInvocations, 1);
    assert.equal(cmdC.numInvocations, 1);
  })
);

test(
  'dependency diamond in one package that succeeds',
  timeout(async ({rig}) => {
    //     a
    //    / \
    //   v   v
    //   b   c
    //    \ /
    //     v
    //     d
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    const cmdC = await rig.newCommand();
    const cmdD = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
          d: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['b', 'c'],
          },
          b: {
            command: cmdB.command,
            dependencies: ['d'],
          },
          c: {
            command: cmdC.command,
            dependencies: ['d'],
          },
          d: {
            command: cmdD.command,
          },
        },
      },
    });
    const exec = rig.exec('npm run a');

    const invD = await cmdD.nextInvocation();
    invD.exit(0);

    const invB = await cmdB.nextInvocation();
    const invC = await cmdC.nextInvocation();
    invB.exit(0);
    invC.exit(0);

    const invA = await cmdA.nextInvocation();
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.equal(cmdB.numInvocations, 1);
    assert.equal(cmdC.numInvocations, 1);
    assert.equal(cmdD.numInvocations, 1);
  })
);

test(
  'cross-package dependency',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['../bar:b'],
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            command: cmdB.command,
          },
        },
      },
    });
    const exec = rig.exec('npm run a', {cwd: 'foo'});

    const invB = await cmdB.nextInvocation();
    invB.exit(0);

    const invA = await cmdA.nextInvocation();
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.equal(cmdB.numInvocations, 1);
  })
);

test(
  'cross-package dependency that validly cycles back to the first package',
  timeout(async ({rig}) => {
    // Cycles between packages are fine, as long as there aren't cycles in the
    // script graph.
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    const cmdC = await rig.newCommand();
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
          c: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['../bar:b'],
          },
          c: {
            command: cmdC.command,
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            command: cmdB.command,
            dependencies: ['../foo:c'],
          },
        },
      },
    });
    const exec = rig.exec('npm run a', {cwd: 'foo'});

    const invC = await cmdC.nextInvocation();
    invC.exit(0);

    const invB = await cmdB.nextInvocation();
    invB.exit(0);

    const invA = await cmdA.nextInvocation();
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.equal(cmdB.numInvocations, 1);
    assert.equal(cmdC.numInvocations, 1);
  })
);

test(
  'finds node_modules binary in starting dir',
  timeout(async ({rig}) => {
    const cmd = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'test-binary',
          },
        },
      },
    });
    await rig.generateAndInstallNodeBinary({
      command: cmd.command,
      binaryPath: 'node_modules/test-pkg/test-binary',
      installPath: 'node_modules/.bin/test-binary',
    });
    const exec = rig.exec('npm run a');
    (await cmd.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmd.numInvocations, 1);
  })
);

test(
  'finds node_modules binary in parent dir',
  timeout(async ({rig}) => {
    const cmd = await rig.newCommand();
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'test-binary',
          },
        },
      },
    });
    await rig.generateAndInstallNodeBinary({
      command: cmd.command,
      binaryPath: 'node_modules/test-pkg/test-binary',
      installPath: 'node_modules/.bin/test-binary',
    });
    const exec = rig.exec('npm run a', {cwd: 'foo'});
    (await cmd.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmd.numInvocations, 1);
  })
);

test(
  'finds node_modules binary across packages (child)',
  timeout(async ({rig}) => {
    const cmd = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['./bar:b'],
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            command: 'test-binary',
          },
        },
      },
    });
    await rig.generateAndInstallNodeBinary({
      command: cmd.command,
      binaryPath: 'bar/node_modules/test-pkg/test-binary',
      installPath: 'bar/node_modules/.bin/test-binary',
    });
    const exec = rig.exec('npm run a');
    (await cmd.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmd.numInvocations, 1);
  })
);

test(
  'finds node_modules binary across packages (sibling)',
  timeout(async ({rig}) => {
    const cmd = await rig.newCommand();
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../bar:b'],
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            command: 'test-binary',
          },
        },
      },
    });
    await rig.generateAndInstallNodeBinary({
      command: cmd.command,
      binaryPath: 'bar/node_modules/test-pkg/test-binary',
      installPath: 'bar/node_modules/.bin/test-binary',
    });
    const exec = rig.exec('npm run a', {cwd: 'foo'});
    (await cmd.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmd.numInvocations, 1);
  })
);

test(
  'starting node_modules binaries are not available across packages (sibling)',
  timeout(async ({rig}) => {
    const cmd = await rig.newCommand();
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../bar:b'],
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            command: 'test-binary',
          },
        },
      },
    });
    await rig.generateAndInstallNodeBinary({
      command: cmd.command,
      binaryPath: 'foo/node_modules/test-pkg/test-binary',
      installPath: 'foo/node_modules/.bin/test-binary',
    });
    const exec = rig.exec('npm run b', {cwd: 'bar'});
    const res = await exec.exit;
    assert.equal(res.code, 1);
    assert.equal(cmd.numInvocations, 0);
    assert.match(
      res.stderr,
      IS_WINDOWS ? "'test-binary' is not recognized" : 'exit status 127'
    );
  })
);

test(
  'commands run under npm workspaces',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    await rig.write({
      'package.json': {
        workspaces: ['foo', 'bar'],
      },
      'foo/package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: cmdA.command,
          },
        },
      },
      'bar/package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: cmdB.command,
          },
        },
      },
    });

    // Run both from the workspaces root package.
    {
      const exec = rig.exec('npm run cmd -ws');
      // Workspace commands run in serial.
      (await cmdA.nextInvocation()).exit(0);
      (await cmdB.nextInvocation()).exit(0);
      assert.equal((await exec.exit).code, 0);
      assert.equal(cmdA.numInvocations, 1);
      assert.equal(cmdB.numInvocations, 1);
    }

    // Run one from the workspace package.
    {
      const exec = rig.exec('npm run cmd', {cwd: 'foo'});
      (await cmdA.nextInvocation()).exit(0);
      assert.equal((await exec.exit).code, 0);
      assert.equal(cmdA.numInvocations, 2);
      assert.equal(cmdB.numInvocations, 1);
    }
  })
);

test.run();
