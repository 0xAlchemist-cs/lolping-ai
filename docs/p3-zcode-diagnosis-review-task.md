# zcode follow-up: make the desktop diagnosis reproducible and guarded

User direction: local only, no pushes/PRs, no additional agents. Codex owns integration
and commits. Retain your current uncommitted work; do not reset or stage unrelated files.

Worktree: `D:/lolping/lolPing-p3-desktop`, branch `feat/p3-packaging-ci`.
Read your current diff and Codex's local branch before continuing. This task supersedes
the previous diagnosis assignment; do not resume the old program-test task.

## Review result

The strict effect gate is useful: reply-only success must fail acceptance. The report
also supplies evidence that the native-only failure does not require Electron overlays.
Production `toggle_desktop.cpp` remains unchanged. Codex is independently checking that
strict mode and the production-overlay smoke; do not run disruptive desktop comparisons
concurrently with Codex or another desktop-input tool.

The report currently overstates causality. A live shared session with a correlational
trigger does not prove internal Explorer bookkeeping, independent bookkeeping for each
API, complete exclusion of caller-side conditions, or the absence of every lolPing
contribution. Keep these as supported hypotheses and limits. An injected Win+D sequence
is not a physical gesture or proof that Windows accepted all injected events.

## Ownership

Only edit:

- `native/desktop-helper/fixtures/fixture_app.cpp`
- `native/desktop-helper/tests/e2e.mjs`
- `native/desktop-helper/README.md`
- `docs/p3-desktop-diagnosis.md`
- optional sanitized evidence file under `docs/` if needed

Do not edit production helper sources/protocol, Main, input helper, settings, packaging,
CI, release files or the environment gate. Codex will merge your README changes with
newer root integration history; do not overwrite that history from your older branch.

## Required revisions

1. Guard or remove test-only keyboard injection. `tapKey` and `injectWinD` ignore the
   `SendInput` count, existing held keys and the current foreground window. They can also
   leave a partial modifier sequence held. If retained, use the established exact-owned-
   foreground/held-input principles, report rejected/partial injection accurately, and
   release only keys your sequence actually pressed. Do not steal foreground, release
   physical user keys, or inject `D` into an unrelated application. If a safe second
   Win+D comparison cannot meet these rules after the desktop takes foreground, remove
   automatic shortcut comparisons and retain the historical observation as reported
   evidence. The default and strict suites must never inject diagnostic shortcuts.
2. Make the fixture command parser exact and bounded. Prefix matches such as `windXYZ`
   must not execute commands; reject unknown/overlong commands. Report diagnostic
   availability/failure explicitly. Keep aggregate-only census data.
3. Correct the foreground experiment. `probeActivationPermission()` creates/activates
   another window, so it can change the condition being measured. The one-time historical
   `foreground` event does not prove foreground ownership immediately before a toggle.
   Several simultaneous fixtures share the same exe path, so an activation request can
   select another instance. Either isolate matching targets (unique approved fixture
   copies) and recheck current foreground at each comparison, or remove the exclusion
   claim and document this confound. No need to force a new experiment on the shared
   desktop just to obtain a favorable result.
4. Separate observation from inference throughout both reports. Record primary output,
   caller conditions actually checked, strict failures/skips and unknowns. Keep the
   single-trigger limitation visible. A minimized count matching baseline does not prove
   every window's arrangement was restored; attribute that statement to what was actually
   observed. The removed selftoggle hang is a reported experiment, not a proven COM stack
   location unless a trace exists.
5. Preserve strict mode's actual effect requirement and bounded child cleanup. Assert
   both replies and minimize/restore. Do not weaken it to green, add production fallback,
   silently retry actions, restart Explorer, change registry/policy, elevate, maintain
   private minimized-window lists, or call global repair operations automatically.

## Validation and handoff

Build with the existing `/W4 /WX` toolchain and run the 101 protocol units. Add focused
checks for changed command parsing/guard behavior where practical. Leave disruptive
desktop runs to an agreed idle window; do not compete with Codex's current strict run.
Report exact commands/results and skips. Unrun strict/diagnostic checks stay unrun.

Leave the revised four files and any small sanitized evidence uncommitted. Do not stage
`.mimosa` or generated binaries. Report completion to the user for Codex to inspect via
local Git. P3A/P3 remain unaccepted pending full wheel and manual acceptance.
