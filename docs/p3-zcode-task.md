# Task for zcode: P3 Windows desktop helper

You are collaborating with Codex on lolPing P3. The user explicitly assigned you the independent Windows native desktop helper module. Coordinate through the shared local Git repository, using separate branches and worktrees.

Your workspace is `D:/lolping/lolPing-p3-desktop`, branch `feat/p3a-desktop-helper`. Codex works in `D:/lolping/lolPing-p3`, branch `feat/p3a-windows-actions`. Read `AGENTS.md`, then `docs/p3-desktop-helper-contract.md` in your workspace first. The contract is the single source of truth for protocol and ownership.

Implement and verify `native/desktop-helper/**` only: the independent C++20 executable, build/test entry point, owned ignore file, native GUI fixtures and README. It activates an existing window matching an approved full exe path, or returns `launchRequired` if no window can be activated; it also invokes Windows Shell ToggleDesktop. It does not launch target applications or change input hooks.

Codex handles the TypeScript adapter, application launch, settings, preload/IPC, i18n, renderer, packaging and CI. Do not modify those files, any sealed P2 workspace, or `native/hook-helper/**`.

Required CLI: `node native/desktop-helper/run.mjs build` and `node native/desktop-helper/run.mjs test`. Output binary: `native/desktop-helper/build/desktop-helper.exe`. The complete one-shot flat JSON protocol and its four expected outcomes are specified in the contract; use it exactly.

Write meaningful tests before the relevant logic, verify failures, implement, then verify passes. Run real Windows executable/window checks where available. Keep synthetic results separate from physical/whole-app acceptance. Do not install dependencies, call paid AI services, publish, push, open PRs or change versions.

Read the other branch's local commits with `git log -5 --oneline feat/p3a-windows-actions` and `git show`, and inspect status with `git -C 'D:/lolping/lolPing-p3' status --short --branch`. Do not edit, switch, reset, merge or cherry-pick into Codex's worktree. Make small local Conventional Commits using explicit owned paths only. Codex will inspect your branch and integrate your native commits.

Record progress and verification evidence in `native/desktop-helper/README.md`. When finished, report your branch, commit hashes, changed paths, commands/results, limitations and outstanding manual checks. If blocked, commit the truthful progress report and explain the exact blocker; do not report an unverified scenario as passed.
