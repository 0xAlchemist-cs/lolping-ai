// `node native/desktop-helper/run.mjs build|test`: builds the desktop helper (and runs its tests) on Windows.
// On other platforms the helper is unsupported; the run reports skipped explicitly and never claims Windows results.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const action = process.argv[2];
if (action !== 'build' && action !== 'test') {
  console.error('usage: node native/desktop-helper/run.mjs build|test');
  process.exit(2);
}

if (process.platform !== 'win32') {
  const what = action === 'build' ? 'build' : 'tests';
  console.log(`desktop-helper: Windows-only; ${what} skipped on ${process.platform}.`);
  // A skipped build must not look like a produced artifact, so it still exits nonzero.
  process.exit(action === 'build' ? 1 : 0);
}

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: here });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// The explicit .\ matters: cmd may be set to not search the current directory for commands.
if (action === 'build') run('cmd.exe', ['/d', '/c', '.\\build.cmd']);
if (action === 'test') {
  run('cmd.exe', ['/d', '/c', '.\\build.cmd']);
  run(join(here, 'build', 'desktop_helper_tests.exe'), []);
  run(process.execPath, [join(here, 'tests', 'fixture_commands.mjs')]);
  run(process.execPath, [join(here, 'tests', 'dwm.mjs')]);
  run(process.execPath, [join(here, 'tests', 'e2e.mjs')]);
}
