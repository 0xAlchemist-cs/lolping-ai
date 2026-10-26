# zcode task: Windows build, package resources and CI

The native module's source has been reviewed by Codex. Product-level desktop restoration is NOT accepted yet: native request success does not prove the window-level effect. Codex owns that investigation and remaining manual acceptance. Do not relax or relabel that check.

## Workspace and ownership

Codex will prepare `D:/lolping/lolPing-p3-desktop` on the new branch `feat/p3-packaging-ci`, based on the integration branch after the native helper commit is integrated. The native implementation branch remains preserved. Check `git branch --show-current` and `git status` before editing. If the new branch is not ready, report it and wait rather than switching or merging on your own.

Read `AGENTS.md` and this brief. This task supersedes the former native-only ownership for these NEW paths only:

- `package.json`: scripts, Windows `extraResources`, and the `build.files` production-file allowlist only.
- `.github/workflows/ci.yml`: Windows build/test/package checks only; preserve existing macOS/Linux jobs.
- `tools/verify-desktop-package.cjs`: a small resource verifier, if needed.
- `docs/p3-packaging-verification.md`: truthful progress, commands and results.

Do not edit native sources/tests, Main, IPC/preload, shared types, renderer, i18n, README, version, dependency versions, lockfile or release workflow. Codex owns those. No new dependencies or permanent system changes. Existing installed dependencies are available through the node_modules junction.

## Deliverables

1. Add `build:desktop` and `test:desktop` scripts invoking the native module's existing run.mjs. Extend Windows `dist` so both existing input helper and desktop helper are built before packaging. Do not add Windows builds to macOS/Linux dist commands.
2. Add only `native/desktop-helper/build/desktop-helper.exe` as Windows extraResources `desktop-helper.exe`, beside `hook-helper.exe`. Never package fixtures, unit-test executables, native object files, user settings or smoke profiles.
   The existing `out/**/*` file pattern also includes local smoke bundles/profiles. Restrict it to the three production directories (`out/main/**/*`, `out/preload/**/*`, `out/renderer/**/*`) and `package.json`, preserving any other required production files. Verify an existing smoke directory is excluded from the package, not just the native extraResources list.
3. Extend the Windows CI job to build/test the desktop helper and verify its packaged resource. Keep existing typecheck, input-helper tests, Vitest, production build and site build. The local existing input-helper test macro needs `CL=/utf-8 /Zc:preprocessor` with MSVC 14.44; set this only for Windows build/test steps where needed, without changing input sources.
4. After a production build, exercise the independent production preload tests. Avoid adding a second competing GUI suite or silently claiming physical/UAC/DPI desktop acceptance. Existing native test skips remain visible in logs.
5. Build a local unpacked Windows application using the installed packager and existing caches; verify resources contain both required helpers and exclude native fixtures. No publishing or app release. If a required artifact is missing and a network download is needed, document that exact blocker rather than installing or downloading without coordination.
6. The resource verifier should inspect a passed unpacked resources path, validate both .exe files exist and are regular files, and fail when either is missing. Prefer testing real small fixture directories for its failure behavior instead of checking source text. Do not mutate actual package contents to test failure.

## Validation and report

Run the new native scripts, relevant verifier positive/negative checks, typecheck and the production/package command needed for this change. Reuse existing evidence for unchanged application suites instead of claiming to have rerun them. Record exact commands, versions, exit status, observed resources, pass/fail/skip and any downloads that were required.

Write the report to `docs/p3-packaging-verification.md`, explicitly separating successful compilation/packaging from unverified real desktop behavior. Do not run paid AI requests, modify the Mimosa gate, use bypass flags, push, create a PR or touch another worktree.

Observe Codex through local `git log -5 --oneline feat/p3a-windows-actions`, `git show`, and `git -C D:/lolping/lolPing-p3 status --short --branch`. Leave completed files for Codex to inspect, commit and integrate. No extra agents.
