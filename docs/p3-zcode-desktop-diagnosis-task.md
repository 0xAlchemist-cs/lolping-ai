# zcode priority task: resolve ToggleDesktop's missing window effect locally

User direction: local fixes first, no new pushes or PRs. Work serially; no extra agents.
The packaging task was accepted and committed by Codex as `0408738` in your worktree.
This task takes priority over `p3-zcode-program-tests-task.md`; pause that task and retain
any work already done. Do not reset, discard or stage unrelated files. Codex owns commits.

Worktree: `D:/lolping/lolPing-p3-desktop`, current `feat/p3-packaging-ci` branch. Read
`AGENTS.md`, `git status`, local `feat/p3a-windows-actions` history and
`git show feat/p3a-windows-actions:docs/p3-acceptance.md` before changing anything.

## Concrete blocking observation

Codex's current production-overlay/native smoke failed at firstDesktopToggle:
`desktopToggled` was returned, but the owned fixture never minimized. Setup restored the
initially minimized fixture and observed it foreground. One earlier run observed a full
round trip after test-only OS-injected Alt; that result was not repeatable.

Crucially, the separate native-only suite also returns two successful toggle replies but
observes no minimize/restore, even WITHOUT Electron overlays. Latest root result:
101 unit passed, 32 e2e passed, 2 skipped (foreground canary and desktop effect).
The cause is NOT established. Do not assume shell corruption or infer hardware success.

## Ownership and task

Own only:

- `native/desktop-helper/src/toggle_desktop.cpp`
- `native/desktop-helper/tests/e2e.mjs`
- `native/desktop-helper/fixtures/fixture_app.cpp`
- `native/desktop-helper/README.md`
- new `docs/p3-desktop-diagnosis.md`

1. Reproduce and isolate the native-only no-effect behavior with owned windows. Record
   useful state and timings without window titles, user content or executable paths from
   unrelated apps. Distinguish caller foreground/input eligibility, COM activation/lifetime,
   asynchronous delivery, fixture observer faults and actual shell state by controlled
   comparisons. Verify both the first minimize and the second restore, not S_OK alone.
2. Implement the smallest supported fix if evidence establishes one. Keep the public flat
   JSON protocol, success semantics and 3-second Main timeout unchanged. No input-hook
   source/protocol changes. Do not edit Main, settings, packaging, CI or program tests.
3. Preserve a deterministic regression when possible. Separate protocol tests from a
   strict opt-in desktop-effect acceptance mode if the environment cannot guarantee it;
   missing effects must remain visibly unverified/failed in strict acceptance.
4. Run native unit/e2e and repeated strict effect checks, report exact passes/fails/skips,
   controlled conditions and remaining limits. If no safe supported fix exists, provide
   the bounded reproduction and evidence; do not report P3A complete.

Do not inject shortcuts in production, maintain a private minimized-window list, force
foreground with AttachThreadInput, change global foreground policy/registry, restart or
kill Explorer, elevate, modify the environment gate, or hide/disable existing product
features to make a test pass. Test-only injected input may be used solely as a clearly
labeled comparison against owned fixture windows; it is not physical input acceptance.

Leave changes uncommitted with the diagnosis report. Coordinate via local Git and the
report file; no network publication. Codex continues Main/full-app checks in its separate
worktree and will review/integrate your final files. Do not start other tasks afterward
until another assignment arrives.
