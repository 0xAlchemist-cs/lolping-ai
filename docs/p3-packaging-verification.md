# P3 packaging verification (zcode, 2026-10-26)

Task: `docs/p3-zcode-packaging-task.md` on `feat/p3-packaging-ci` (branch base `ea8503a`,
plus Codex's in-flight amendment `7d3e645` adding the `build.files` allowlist to scope).
Everything below ran on this machine (Windows 11 26100 x64, Node 22.15.0, local MSVC
14.44.35207) through the shared `node_modules` junction; no dependency, lockfile, version or
release-workflow change was made, and no gate or other worktree was touched.

**What is verified: scripts, packaging configuration, resource contents and CI wiring.
What is NOT verified: real desktop restoration behaviour. Native request success and package
correctness do not prove window-level desktop effects; that acceptance stays with Codex
(hardware mouse, UAC, mixed DPI, full lolPing wheel). Native suite skips remain visible in
every log below.**

## Changed files (all four in scope)

- `package.json` — scripts + Windows `extraResources` + `build.files` allowlist only
- `.github/workflows/ci.yml` — Windows `test` job only (macOS/Linux jobs untouched)
- `tools/verify-desktop-package.cjs` — new resource verifier
- `docs/p3-packaging-verification.md` — this report

## 1. Scripts and dist chain (`package.json`)

Added `"build:desktop": "node native/desktop-helper/run.mjs build"` and
`"test:desktop": "node native/desktop-helper/run.mjs test"` beside the input-helper pair.
Windows `dist` now runs `build:helper && build:desktop && electron-vite build &&
electron-builder --win --publish never`. `dist:mac` / `dist:linux` are unchanged; the
desktop helper is Windows-only and its `run.mjs` reports skip on other platforms.

Results: `npm run build:desktop` exit 0 (builds `desktop-helper.exe`,
`desktop_helper_tests.exe`, `fixture_app.exe` under the ignored `build/` directory).
`npm run test:desktop` exit 0: **unit 101 passed / 0 failed; e2e 32 passed / 0 failed /
2 skipped** (foreground-permission canary skip and toggle-window-observation skip, both
printed with reasons). `npm run typecheck` exit 0.

## 2. Package contents (`package.json` build config)

Windows `extraResources` now ships exactly `native/desktop-helper/build/desktop-helper.exe`
as `desktop-helper.exe` beside the existing `hook-helper.exe`. `build.files` was restricted
from `out/**/*` to `out/main/**/*`, `out/preload/**/*`, `out/renderer/**/*`, `package.json`,
so local smoke bundles and profiles placed under `out/` can no longer be packaged.

Evidence (real unpacked build, see §5): `release/win-unpacked/resources/` contains
`desktop-helper.exe` (166912 bytes) and `hook-helper.exe` (305664 bytes), both regular
files; no `fixture_app.exe`, no test executables, no `obj/`. With a probe directory
`out/verify-smoke-probe/main.cjs` present during packaging, `npx asar list` of
`resources/app.asar` shows **0 entries** under the probe (226 entries total:
`\out\main\index.js`, all five `\out\preload\*.js`, 216 `\out\renderer\…` entries,
`\package.json`). The probe was removed afterwards; `out/` is back to
main/preload/renderer only.

## 3. CI (`ci.yml`, Windows `test` job only)

Kept: `npm ci`, typecheck, `test:helper`, `npm test`, `npm run build`, `build:site`.
Added:

- `test:helper` step now sets `CL: -utf-8 /Zc:preprocessor` — required by the existing
  input-helper test macro under the runner's MSVC 14.44; input sources unchanged, and the
  flag is scoped to that step only.
- `npm run test:desktop` after it; its fixture scenarios skip with visible reasons if the
  runner lacks an interactive desktop.
- `npx vitest run tests/main/preloadBundle.test.ts` after `npm run build`: the preload
  production tests auto-skip without build output, and `npm test` runs before the build.
  Locally this file passes **10/10** against the fresh `out/preload` (exit 0).
- `npm run dist` then `node tools/verify-desktop-package.cjs release/win-unpacked/resources`
  to package with both helpers and check the unpacked resources on the runner.

Not yet exercised: the workflow itself (first real run happens on push; macOS/Linux jobs
untouched by this diff).

## 4. Verifier (`tools/verify-desktop-package.cjs`)

Takes one argument (the unpacked `resources` directory), fails with exit 1 and a listed
reason when `hook-helper.exe` or `desktop-helper.exe` is missing or not a regular file, or
when a native test/fixture artifact (`fixture_app.exe`, `desktop_helper_tests.exe`,
`helper_tests.exe`, `obj`) appears in the package. Failure behaviour was tested against six
real temporary fixture directories (the actual package was never mutated): both-present
(exit 0), desktop-helper missing, hook-helper missing, desktop-helper-is-a-directory,
fixture packaged, tests-exe packaged (all exit 1 with the expected message) — 6/6 as
expected. Against the real unpacked package: `OK … both helpers present as regular files;
no test artifacts`, exit 0.

## 5. Local unpacked package build

Commands and exit status, in order: `npm run build:helper` (0), `npm run build:desktop`
(0), `npm run build` (electron-vite, 0), then
`npx electron-builder --win --x64 --dir --publish never` (0), producing
`release/win-unpacked/lolPing.exe` plus verified resources above. No new downloads were
needed: the Electron 44.5.1 win32-x64 zip was already in the local `@electron/get` cache
(`%LOCALAPPDATA%/electron/Cache`, three entries; electron-builder's own cache directory
stayed empty, and the `--dir` target does not fetch the NSIS toolset). The builder's log
line `downloaded electron` reflects retrieving that cached zip.

**Exact blocker, documented instead of downloading:** the full `npm run dist` (NSIS
installer) was not run locally because the NSIS toolset is not in electron-builder's cache
and fetching it would be a network download this task asked to coordinate first. The chain
up to and including electron-builder is verified (identical config path; only the NSIS
packaging step differs), and CI runs the full `dist` with network. No publishing or
release was attempted.

## 6. Not claimed / remaining manual items

- Real desktop restoration, hardware mouse, UAC/elevated targets, mixed DPI and the full
  lolPing wheel: unverified here, as before; native skips stay visible in logs.
- Full NSIS installer build and the CI workflow run: pending (blocker above / first push).
- Application suites that did not change were not rerun: only `typecheck`,
  `preloadBundle.test.ts`, the two native suites and the packaging/verifier commands in
  this report were executed in this session.
