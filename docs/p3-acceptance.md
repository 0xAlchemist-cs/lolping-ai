# P3 implementation and acceptance checkpoint

Date: 2026-10-26. Baseline: `34f0e070500fbbbabfd24ba75b8c6008ce13f0e6`.
Worktree: `D:/lolping/lolPing-p3`, branch `feat/p3a-windows-actions`.

P3 code is available for review, with the feature off by default. **P3 is not accepted for
completion or release.** The desktop effect is not stable in this Windows session, and
the required physical-input, elevated-target and mixed-DPI checks remain open. Keep the PR
in draft until the blocking items below are resolved. No merge, release or version change
is part of this checkpoint.

## Automated evidence run by Codex

Machine: Windows 11 build 26100 x64, Node 22.15.0, local MSVC 14.44. The display smoke
reported one 2560×1600 display at scale 1.25. This does not cover 100/150/200% or mixed DPI.
Existing dependencies were reused through the local junction; no lockfile changes.

| Check | Result | Scope |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | Strict TypeScript |
| `npm test -- --reporter=dot` | 1398 passed, 86 files, exit 0 | Includes latest cancellation, post-await capability expiry and canonical-path regressions |
| `npm run build` | exit 0 | Main, renderer and five independent sandbox preload bundles |
| `npm run build:site` | exit 0 | Browser demo uses a no-op action shim |
| `npm run test:helper` with `CL='/utf-8 /Zc:preprocessor'` | 542 passed, exit 0 | Original input helper unchanged; flags address the existing local MSVC source/macro compatibility issue |
| `npm run test:desktop` | 101 unit checks; 32 e2e passed, 0 failed, 2 skipped; exit 0 | Foreground-success canary and desktop window effect unavailable in this session; denial/matching and minimized restoration still checked |
| `node tools/vision-smoke.cjs` | PASS | Controlled Windows capture/overlay/AI-card regression; synthetic gestures |
| `node tools/window-resize-smoke.cjs` | PASS | Owned-window native resize, injected mouse input |
| `node tools/vision-ai-smoke.cjs` | PASS | Synthetic JPEG/SSE integration |
| `node tools/ai-diagnostics-smoke.cjs` | PASS | Synthetic AI stream, keyboard and failure cases |
| `node tools/clipboard-smoke.cjs` | PASS | Controlled clipboard cases; fixture output only |
| `node tools/settings-input-smoke.cjs` | PASS | Real Fluent controls, controlled settings IPC |
| `node tools/quick-actions-smoke.cjs` | PASS | Real Fluent controls; 3 saves, 2 synthetic tests, 3 picks, 1 removal; bilingual/platform/stale-draft guards |
| `electron-builder --win --x64 --dir --publish never` | exit 0 | Current integrated unpacked Windows build, cached Electron artifact |
| `node tools/verify-desktop-package.cjs release/win-unpacked/resources` | exit 0 | Both production helpers are regular files; no top-level native fixtures/test artifacts |

The AI smoke tools use synthetic data or injected local implementations. No paid API was
called. External HTTP requests were zero in the tools that report that counter.

## Strict desktop observation: unresolved

`node tools/ping-actions-smoke.cjs` uses production overlay/preload code, Main session
validation and the real bundled desktop helper. Input-bridge events are synthetic. A
test-only Alt tap is OS-injected while an owned fixture is foreground; it is never used
by production code. The test requires actual window minimization and restoration after
two wheel selections, in addition to successful native replies. It does not downgrade
missing effects to a pass.

One controlled run observed `minimized → restored → minimized → restored`, two `omw`
actions, unchanged question-mark reporting and zero external requests. A later rerun
against the freshly built root helper **failed** at `firstDesktopToggle`: the helper
returned `desktopToggled`, but the fixture only reported its setup `minimized → restored`
and did not minimize after the action. The independent native suite, without Electron
overlays, also accepted two toggle requests while observing no window effect (explicit
skip). This narrows the reproduction but does not establish the cause or rule out
overlay interference in other conditions.

Microsoft documents ToggleDesktop as showing/hiding the desktop under the shell's own
rules: [IShellDispatch4.ToggleDesktop](https://learn.microsoft.com/en-us/windows/win32/shell/ishelldispatch4-toggledesktop).
A successful native request alone cannot satisfy the product's window-level acceptance.
Do not replace the strict assertion with a request-only check, silently retry desktop
actions, inject production shortcuts or suppress existing features to obtain a pass.

## Acceptance still required

- Resolve the intermittent no-effect desktop behavior and record repeatable two-gesture
  desktop restoration in the full app, including existing AI cards and other overlays.
- Physical mouse with the existing trigger keys and side buttons; click/pass-through,
  center/Esc/right-click cancellation, pause and settings key capture.
- Ordinary, minimized, tray-only and multiple application windows, launchers, denied
  activation, and UAC/elevated targets. Controlled fixtures cover part of this matrix.
- 100/150/200% DPI, mixed monitors, cross-screen gestures, monitor removal and display-mode
  changes; lock/unlock and secure-desktop return.
- Same-machine CPU/memory baseline and release-to-dispatch P95 measurement (target ≤100ms);
  no performance claim has been established by the functional tests.
- Full NSIS installer build and remote Windows/macOS/Linux CI. Only the Windows unpacked
  build was run locally. See `p3-packaging-verification.md` for zcode's separate report.
- Human UI review and screenshot, and review of the complete diff before merge.

## Coordination

Codex committed the native handoff and packaging with normal Git, without modifying or
bypassing zcode's environment gate. External `feat/p3-packaging-ci` commit `0408738` was
integrated as `00acde7`. Only the native module and the four agreed packaging paths were
included; `.mimosa` state was excluded. The next zcode task is defined in
`p3-zcode-program-tests-task.md`; its results are not included in the counts above.
