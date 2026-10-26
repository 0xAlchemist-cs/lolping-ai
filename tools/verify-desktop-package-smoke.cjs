const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createPackage } = require('@electron/asar');
(async () => {
  const out = path.resolve(__dirname, '../out');
  await fs.mkdir(out, { recursive: true });
  const root = await fs.mkdtemp(path.join(out, 'verifier-cases-'));
  let passed = 0;
  try {
    for (const kind of ['resources', 'validArchive', 'smokeLeak', 'fixtureLeak', 'invalidArchive', 'missingHelper']) {
      const dir = path.join(root, kind);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'hook-helper.exe'), 'fixture');
      if (kind !== 'missingHelper') await fs.writeFile(path.join(dir, 'desktop-helper.exe'), 'fixture');
      if (kind === 'invalidArchive') await fs.writeFile(path.join(dir, 'app.asar'), 'invalid');
      if (['validArchive', 'smokeLeak', 'fixtureLeak'].includes(kind)) {
        const source = path.join(root, kind + '-src');
        await fs.mkdir(path.join(source, 'out/main'), { recursive: true });
        await fs.writeFile(path.join(source, 'package.json'), '{}');
        await fs.writeFile(path.join(source, 'out/main/index.js'), '');
        if (kind === 'smokeLeak') {
          await fs.mkdir(path.join(source, 'out/smoke/profile'), { recursive: true });
          await fs.writeFile(path.join(source, 'out/smoke/profile/settings.json'), '{}');
        }
        if (kind === 'fixtureLeak') await fs.writeFile(path.join(source, 'out/main/fixture_app.exe'), 'fixture');
        await createPackage(source, path.join(dir, 'app.asar'));
      }
      const run = spawnSync(process.execPath, [path.resolve('tools/verify-desktop-package.cjs'), dir], { encoding: 'utf8' });
      const expected = ['resources', 'validArchive'].includes(kind) ? 0 : 1;
      if (run.status !== expected) throw new Error(kind + ': ' + run.stdout + run.stderr);
      passed++;
    }
    console.log(JSON.stringify({ verifierCases: passed, status: 'PASS' }));
  } finally {
    const real = await fs.realpath(root);
    if (!real.startsWith(out + path.sep)) throw new Error('cleanup path outside owned output');
    await fs.rm(real, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
