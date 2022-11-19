/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {timeout, wait} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';
import * as os from 'os';
import {IS_WINDOWS} from '../util/windows.js';

import type {PackageJson} from './util/package-json.js';

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
  'by default we run dependencies in parallel',
  timeout(async ({rig}) => {
    // Note the test rig set WIREIT_PARALLELISM to 10 by default, even though
    // the real default is based on CPU count.
    const dep1 = await rig.newCommand();
    const dep2 = await rig.newCommand();
    const main = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          dep1: 'wireit',
          dep2: 'wireit',
          main: 'wireit',
        },
        wireit: {
          dep1: {command: dep1.command},
          dep2: {command: dep2.command},
          main: {command: main.command, dependencies: ['dep1', 'dep2']},
        },
      },
    });

    {
      const exec = rig.exec('npm run main');
      // The two deps are invoked immediately, but main isn't
      const [inv1, inv2] = await Promise.all([
        dep1.nextInvocation(),
        dep2.nextInvocation(),
      ]);
      assert.equal(main.numInvocations, 0);
      inv1.exit(0);
      inv2.exit(0);
      // now main is invoked, and the command exits
      (await main.nextInvocation()).exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(dep1.numInvocations, 1);
      assert.equal(dep2.numInvocations, 1);
      assert.equal(main.numInvocations, 1);
    }
  })
);

test(
  'can set WIREIT_PARALLEL=1 to run sequentially',
  timeout(async ({rig}) => {
    const dep1 = await rig.newCommand();
    const dep2 = await rig.newCommand();
    const main = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          dep1: 'wireit',
          dep2: 'wireit',
          main: 'wireit',
        },
        wireit: {
          dep1: {command: dep1.command},
          dep2: {command: dep2.command},
          main: {command: main.command, dependencies: ['dep1', 'dep2']},
        },
      },
    });

    const exec = rig.exec('npm run main', {env: {WIREIT_PARALLEL: '1'}});
    // One of the two deps are invoked first
    const dep1InvPromise = dep1.nextInvocation();
    const dep2InvPromise = dep2.nextInvocation();
    // wait for the first command to begin
    const luckyInv = await Promise.race([dep1InvPromise, dep2InvPromise]);
    // wait for a bit, to show that the other command does not begin
    await wait(300);
    let unluckyInvPromise;
    if (luckyInv.command === dep1) {
      unluckyInvPromise = dep2InvPromise;
      assert.equal(dep1.numInvocations, 1);
      assert.equal(dep2.numInvocations, 0);
    } else {
      unluckyInvPromise = dep1InvPromise;
      assert.equal(dep1.numInvocations, 0);
      assert.equal(dep2.numInvocations, 1);
    }
    assert.equal(main.numInvocations, 0);
    // once the lucky dep finishes, the unlucky one is invoked
    luckyInv.exit(0);
    (await unluckyInvPromise).exit(0);
    // and then finally main is invoked and the command exits
    (await main.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(dep1.numInvocations, 1);
    assert.equal(dep2.numInvocations, 1);
    assert.equal(main.numInvocations, 1);
  })
);

test(
  'can set WIREIT_PARALLEL=Infinity to run many commands in parallel',
  timeout(async ({rig}) => {
    const main = await rig.newCommand();
    // Pick a number of scripts that we will expect to run simultaneously which is
    // higher than the default of CPUs x 4, to show that we have increased beyond
    // that default.
    const n = os.cpus().length * 10;
    const depNames: string[] = [];
    const packageJson: PackageJson = {
      scripts: {
        main: 'wireit',
      },
      wireit: {
        main: {command: main.command, dependencies: depNames},
      },
    };
    const commands = [];
    const invocations = [];
    for (let i = 0; i < n; i++) {
      const command = await rig.newCommand();
      commands.push(command);
      const name = `dep${i}`;
      depNames.push(name);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      packageJson.scripts![name] = 'wireit';
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      packageJson.wireit![name] = {command: command.command};
      invocations.push(command.nextInvocation());
    }

    await rig.write({
      'package.json': packageJson,
    });

    const exec = rig.exec('npm run main', {env: {WIREIT_PARALLEL: 'Infinity'}});
    // All invocations should be started simultaneously
    const started = await Promise.all(invocations);
    for (const invocation of started) {
      invocation.exit(0);
    }
    // once they're all done, main still finishes normally
    (await main.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    for (const cmd of commands) {
      assert.equal(cmd.numInvocations, 1);
    }
    assert.equal(main.numInvocations, 1);
  })
);

test(
  'should fall back to default parallelism with empty WIREIT_PARALLEL',
  timeout(async ({rig}) => {
    const dep1 = await rig.newCommand();
    const dep2 = await rig.newCommand();
    const main = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          dep1: 'wireit',
          dep2: 'wireit',
          main: 'wireit',
        },
        wireit: {
          dep1: {command: dep1.command},
          dep2: {command: dep2.command},
          main: {command: main.command, dependencies: ['dep1', 'dep2']},
        },
      },
    });

    const exec = rig.exec('npm run main', {env: {WIREIT_PARALLEL: ''}});
    const [inv1, inv2] = await Promise.all([
      dep1.nextInvocation(),
      dep2.nextInvocation(),
    ]);
    assert.equal(main.numInvocations, 0);
    inv1.exit(0);
    inv2.exit(0);
    (await main.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(dep1.numInvocations, 1);
    assert.equal(dep2.numInvocations, 1);
    assert.equal(main.numInvocations, 1);
  })
);

test(
  'scripts acquire exclusive locks across wireit processes',
  timeout(
    async ({rig}) => {
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

      // Start up <concurrency> simultaneous Wireit invocations for the same
      // script.
      const concurrency = 10;
      const wireits = [];
      for (let i = 0; i < concurrency; i++) {
        wireits.push(rig.exec('npm run a'));
      }

      // Wait a moment to give a chance for scripts to start up.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Wait for each command invocation to start, and check that only one starts
      // at a time.
      for (let i = 0; i < concurrency; i++) {
        const inv = await cmdA.nextInvocation();
        // Note that numInvocations is incremented as soon as the script starts,
        // even if we haven't called nextInvocation yet.
        assert.equal(cmdA.numInvocations, i + 1);
        inv.exit(0);
      }

      for (const exec of wireits) {
        assert.equal((await exec.exit).code, 0);
      }

      assert.equal(cmdA.numInvocations, concurrency);
    },
    IS_WINDOWS ? 60_000 : undefined
  )
);

test(
  "scripts don't acquire exclusive locks when output=[]",
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
            output: [],
          },
        },
      },
    });

    // When output=[], we don't acquire an exclusive lock.
    const exec1 = rig.exec('npm run a');
    const exec2 = rig.exec('npm run a');
    const inv1 = await cmdA.nextInvocation();
    // inv2 couldn't start if we did acquire an exclusive lock, because inv1 is
    // still running.
    const inv2 = await cmdA.nextInvocation();
    inv1.exit(0);
    inv2.exit(0);
    assert.equal((await exec1.exit).code, 0);
    assert.equal((await exec2.exit).code, 0);
    assert.equal(cmdA.numInvocations, 2);
  })
);

test.run();
