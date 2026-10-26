# zcode next task: program boundary regression tests

The packaging task is accepted into local commit `0408738` on `feat/p3-packaging-ci`.
Codex owns commits and PR creation. Do not retry or bypass your environment's commit gate.
Do not spawn other agents. Coordinate through local Git status, refs and this report path.

Worktree: `D:/lolping/lolPing-p3-desktop`. Continue on the current branch; do not switch
branches, reset files, or alter another worktree. Inspect `feat/p3a-windows-actions` for
Codex's current implementation; read `AGENTS.md` and `src/main/quickActionProgram.ts` first.

Own ONLY these new files:

- `tests/main/quickActionProgram.test.ts`
- `docs/p3-program-verification.md`

Add meaningful tests for the existing `verifyQuickActionProgram` and `launchQuickActionProgram`.
Prefer temporary real files/directories and OS behavior to assertions mirroring implementation.
Cover invalid/nonlocal/non-exe paths, missing files, directory named `.exe`, valid regular exe,
spaces/apostrophes/ampersands, canonical targets, and missing-launch rejection. Gate Windows-specific
checks explicitly; other platforms must remain runnable. Clean up only owned temporary paths/processes.
Do not launch arbitrary installed applications or touch the real user's settings. A controlled copied
fixture may be used only if safely owned and bounded. Do not modify production source, native code,
package/CI files, lockfiles or unrelated tests. If a defect needs source changes, report the concrete
reproduction and leave the fix to Codex.

Run the targeted Vitest file and typecheck using existing dependencies. The report must state exact
commands/results/skips, actual boundaries proved, and any untested cases. No paid API or downloads.
Leave files uncommitted for Codex to review and integrate. This task proves filesystem/process
boundaries, not foreground behavior, physical gestures or full P3 acceptance.
