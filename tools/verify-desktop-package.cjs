/* Verifies an unpacked Windows package's resources: both native helpers must be present as
 * regular files, and nothing that only exists for tests may have been packaged. Usage:
 *   node tools/verify-desktop-package.cjs <unpacked resources directory>
 * Exit 0 when the resources are correct, 1 with a listed reason otherwise. */
const { existsSync, lstatSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');

const required = ['hook-helper.exe', 'desktop-helper.exe'];
// Everything the native build directory contains besides the two shipped helpers.
const forbidden = ['fixture_app.exe', 'desktop_helper_tests.exe', 'helper_tests.exe', 'obj'];

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/verify-desktop-package.cjs <unpacked resources directory>');
  process.exit(1);
}
const resources = resolve(dir);

const problems = [];
let entries = [];
try {
  entries = readdirSync(resources);
} catch (err) {
  console.error(`cannot read resources directory ${resources}: ${err.code || err.message}`);
  process.exit(1);
}

for (const name of required) {
  try {
    const st = lstatSync(resolve(resources, name));
    if (!st.isFile()) problems.push(`${name} exists but is not a regular file`);
  } catch {
    problems.push(`${name} is missing from the package resources`);
  }
}

for (const name of forbidden) {
  if (entries.includes(name)) problems.push(`${name} must not be packaged (test/fixture artifact)`);
}

const archive = resolve(resources, 'app.asar');
let archiveEntries = null;
if (existsSync(archive)) {
  try {
    const { listPackage } = require('@electron/asar');
    const paths = listPackage(archive).map(name => name.replaceAll('\\', '/'));
    archiveEntries = paths.length;
    for (const name of paths) {
      if (name !== '/package.json' && !/^\/out(?:\/(?:main|preload|renderer)(?:\/.*)?)?$/.test(name)) {
        problems.push(`unexpected app.asar entry: ${name}`);
      }
      if (name.split('/').some(part => forbidden.includes(part))) problems.push(`test artifact in app.asar: ${name}`);
    }
  } catch (err) {
    problems.push(`cannot inspect app.asar: ${err.code || err.message}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(1);
}
console.log(`OK ${required.join(', ')} present as regular files; no test artifacts in ${resources}; `
  + (archiveEntries === null ? 'no app.asar supplied' : `${archiveEntries} production app.asar entries`));
