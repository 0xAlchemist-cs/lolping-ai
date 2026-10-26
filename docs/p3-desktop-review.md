# Codex review of the ToggleDesktop diagnosis handoff

Date: 2026-10-26. Windows 11 build 26100 x64. Local work only; no push or PR.

Outcome: the strict gate detects the live failure correctly. The diagnosis handoff
is not yet accepted for integration, and P3A/P3 remain incomplete. No production fallback,
retry, input injection or shell-state repair was added.

## Source inspected

Reviewed zcode's uncommitted fixture, e2e test, native README and report in
`D:/lolping/lolPing-p3-desktop`, branch `feat/p3-packaging-ci` at `0408738`.
Production `src/toggle_desktop.cpp` has no diff. Inspected SHA-256 values:

| File | SHA-256 |
| --- | --- |
| `native/desktop-helper/tests/e2e.mjs` | `ebb4eef8eb8b20b2db1d1e629d8586258ba2bf8329fe970855e6c6aeb98c2426` |
| `native/desktop-helper/fixtures/fixture_app.cpp` | `d29a32facf0df336006988eabdad8e3512be9fef76883c688c8e2b147923b052` |
| `native/desktop-helper/src/toggle_desktop.cpp` | `fc81429e4e7b928515ba9b42d46e2a3c6f40e661778207e15ada509951b363ca` |

External files remain in their owning worktree. Root retains its newer native README
integration history; a later handoff must merge that history rather than overwrite it.
`.mimosa` and generated binaries are excluded from integration.

## Independent native strict run

Executed from the external worktree, with diagnostic input disabled:

```powershell
$env:LOLPING_DESKTOP_DIAG = '0'
$env:LOLPING_DESKTOP_EFFECT_STRICT = '1'
node native/desktop-helper/run.mjs test
```

Build passed with `/W4 /WX`. Protocol units: **101 passed**. E2e:
**31 passed, 1 failed, 1 skipped; exit 1**. The skip was the foreground-success canary;
denied activation cases still verified matching and refusal.

Both desktop requests returned `desktopToggled` with exit 0. Each had a ten-second
window to observe the owned fixture. Neither transition appeared; at t+20673ms the test
reported `effect none (saw nothing then nothing)` and failed `strict desktop effect`.

Log: `out/p3-desktop-review/native-strict-61d86444.log` in the root worktree. No diagnostic
Win+D, Alt, PowerShell comparison, MinimizeAll or UndoMinimizeALL operation ran.
This verifies the strict gate's failure behavior; it does not reproduce zcode's earlier
passing effects or accept current reliability.

## Production-overlay comparison without injected Alt

Root added `--no-input` to the existing overlay smoke and ran:

```powershell
node tools/ping-actions-smoke.cjs D:/lolping/lolPing-p3-desktop/native/desktop-helper/build --no-input
```

This uses production OverlayManager, sandbox overlay/preload, session validation,
executor and DesktopBridge. Helper events and availability/binding routing are harnessed;
this is not the complete Main entry or a real mouse gesture. Native helper/fixture
artifacts are from the freshly built handoff.

Result: **FAIL**, exit 1, at `firstDesktopToggle` / `fixtureDidNotMinimize`.
The fixture's setup `minimized → restored` and foreground state were observed after
native activation. The first `omw` action returned `ok: true, status: desktopToggled`,
but the fixture never minimized. There were zero external HTTP requests. The second
wheel action was not attempted after the first effect failed. No Alt or other input was
injected and no global repair was attempted.

Log: `out/p3-desktop-review/overlay-no-input-8a8604b6.log`. The setup restore is not a
successful desktop round trip. Native failure does not require an Electron overlay or
injected Alt; these results do not exclude overlay/caller effects in other conditions.

## Required revisions before integration

1. Diagnostic `tapKey` / `injectWinD` do not check inserted-event counts, held input or
   foreground ownership. Their unconditional acknowledgments do not prove delivery;
   partial input needs cleanup of keys actually pressed by the test. Default/strict
   modes do not use these commands. Microsoft's
   [SendInput documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
   specifies its event-count return and existing-key-state considerations.
2. Prefix parsing accepts commands such as `windXYZ`. A channel that can inject input
   needs exact commands and bounded rejection of overlong input.
3. The foreground canary creates/activates another fixture, changing the condition being
   investigated. A historical `foreground` event is not a live check at the next toggle.
   Simultaneous fixtures use the same exe path, so path-based activation can select
   another instance. These confounds prevent complete exclusion of caller eligibility.
4. Internal shell bookkeeping is a plausible inference from shared-session observations,
   not an isolated causal reproduction. Injected Win+D is not physical input. Matching
   minimized counts do not establish every window's layout. The removed selftoggle hang
   remains a reported experiment unless a trace establishes where it blocked.

The bounded follow-up is `p3-zcode-diagnosis-review-task.md`, local commit `9266a69`.
Zcode retains ownership; Codex did not edit those external files or run their unguarded
diagnostic input mode.

## Product decision and root test changes

Keep documented
[ToggleDesktop](https://learn.microsoft.com/en-us/windows/win32/shell/ishelldispatch4-toggledesktop)
behavior and the 3-second Main timeout. A successful reply is not effect acceptance.
Do not silently replace it with a direction heuristic: documented
[UndoMinimizeALL](https://learn.microsoft.com/en-us/windows/win32/shell/ishelldispatch-undominimizeall)
undoes the last MinimizeAll operation; shared-session observations do not establish an
interchangeable, reliable toggle. No repair action is added to settings.

Root's test-only Alt script now rejects held mouse buttons as well as modifiers,
rechecks the foreground handle, and attempts keyup for its own Alt if only its down event
was inserted. Compilation and an impossible foreign-PID check passed: expected guard
rejection, exit 1, before input. Partial-insertion cleanup was reviewed but not forced
at runtime. `--no-input` bypasses this script. Production input/protocol/settings and
release configuration are unchanged.

Fresh root checks passed: typecheck, 1414 Vitest tests / 87 files, 542 original helper
units, and `--dispatch-only` (100 synthetic samples, P95 11.84ms, max 14.43ms, no desktop
effects or HTTP). These passing checks do not override either strict failure.

## Remaining acceptance

The desktop-effect blocker is still reproduced. Resolve it with supported behavior and
repeatable effects before P3A completion. Full Main plus actual desktop actions, two
real wheel operations including existing AI cards, physical mouse, UAC/elevated targets,
mixed DPI, multiple displays and secure-desktop return remain unaccepted. A clean,
isolated Windows session can separate session history from application lifecycle effects;
no VM experiment was performed in this review.
