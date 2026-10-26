# P3 implementation and acceptance checkpoint

Date: 2026-10-26. Baseline: `34f0e070500fbbbabfd24ba75b8c6008ce13f0e6`.
Worktree: `D:/lolping/lolPing-p3`, branch `feat/p3a-windows-actions`.

P3 code is available for review, with the feature off by default. **P3 is not accepted for
completion or release.** The desktop effect is not stable in this Windows session, and
the required physical-input, elevated-target and mixed-DPI checks remain open. Work stays
local under the user's latest direction; do not create or update a PR. No merge, release
or version change is part of this checkpoint.

## Automated evidence run by Codex

Machine: Windows 11 build 26100 x64, Node 22.15.0, local MSVC 14.44. The display smoke
reported one 2560×1600 display at scale 1.25. This does not cover 100/150/200% or mixed DPI.
Existing dependencies were reused through the local junction; no lockfile changes.

| Check | Result | Scope |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | Strict TypeScript |
| `npm test -- --reporter=dot` | 1414 passed, 87 files, exit 0 | Includes cancellation, post-await capability expiry, canonical-path regressions and 16 real-file program-boundary cases |
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
| `node tools/ping-actions-hook-smoke.cjs` | 17 cases passed, exit 0 | Unchanged real input helper → InputBridge → production overlay/preload → executor; OS-injected input, open operation stubbed, Main availability harnessed; 11 releases, 10 wheel Pings, 7 recorded actions; no desktop effects |
| `node tools/ping-actions-app-smoke.cjs` | 18 scenarios passed, exit 0 | Actual built Main entry, real settings/preload/store/Hook; browser/dialog/native-job boundaries controlled; real capture/pause/close/config cancellation and graceful shutdown; 8 wheel Pings, 6 recorded URLs, 3 canceled children, 0 program launches or HTTP requests |
| `node tools/ping-actions-idle-benchmark.cjs out/p3-performance/baseline-34f0e070` | ABBA comparison passed; 20 accepted idle intervals per version | Actual baseline/current built Main, identical dependencies/input-helper binary, isolated offline profiles; current mean CPU 1.759% of one core, working-set sum 524.10 MiB, private allocation 357.42 MiB; see `p3-performance-verification.md` for baseline and limits |
| `node tools/ping-actions-idle-benchmark.cjs --enabled-only` | 10 accepted idle intervals, exit 0 | Enabled with a saved web binding; one input helper, zero desktop-helper launches or external requests |
| `node tools/ping-actions-app-smoke.cjs --latency` | Two 100-sample runs passed; P95 9.47ms and 8.30ms; maxima 11.26ms and 10.20ms | Full Main, OS-injected guarded gestures; helper stdout receipt to controlled browser-request interface, excluding hardware/hook delivery and actual OS/browser work |
| `node tools/ping-actions-smoke.cjs --dispatch-only` | 100 samples; P50 3.30ms, P95 10.83ms, max 13.25ms; exit 0 | Production overlay/preload IPC from Main release to executor's native-request boundary; native result stubbed, no desktop effects or physical gesture |
| `electron-builder --win --x64 --dir --publish never` | exit 0 | Current integrated unpacked Windows build, cached Electron artifact |
| `electron-builder --win --x64 --publish never` with workspace `ELECTRON_BUILDER_CACHE` | exit 0 | Full NSIS installer rebuilt with the capture-state fix, 171861103 bytes; not installed or published |
| `node tools/verify-desktop-package.cjs release/win-unpacked/resources` | exit 0 | Both production helpers are regular files; no native fixtures/test artifacts; all 226 actual app.asar entries restricted to production paths |
| `node tools/verify-desktop-package-smoke.cjs` | 6 fixture cases, exit 0 | Resource-only/valid archive pass; missing helper, leaked smoke profile, leaked fixture and malformed archive fail |

The AI smoke tools use synthetic data or injected local implementations. No paid API was
called. External HTTP requests were zero in the tools that report that counter.
The latest Fluent smoke additionally verified every Ping icon loaded and wrote the local
controlled-component preview to `out/quick-actions-smoke/quick-actions.png`. It is not a
screenshot of a physical user's full-app session and does not complete human UI acceptance.
The first full installer attempt failed with `EXDEV` while renaming electron-builder's
profile-cache extraction directory. Its supported `ELECTRON_BUILDER_CACHE` override under
`out/builder-cache` resolved the failure. The application/package configuration was not
weakened; the build cache is excluded from `app.asar` by the production allowlist.

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
  center/Esc/right-click cancellation, pause and settings key capture. The controlled
  real-hook checks now pass with OS-injected input; see `p3-input-verification.md` for
  scope and limits. The complete Main entry is additionally exercised by the isolated
  full-app harness in `p3-full-app-verification.md`, with external effects controlled.
- Ordinary, minimized, tray-only and multiple application windows, launchers, denied
  activation, and UAC/elevated targets. Controlled fixtures cover part of this matrix.
- 100/150/200% DPI, mixed monitors, cross-screen gestures, monitor removal and display-mode
  changes; lock/unlock and secure-desktop return.
- Full-app physical release-to-system-request P95 measurement (target ≤100ms), cold first
  actions, sustained actions/failures/timeouts and actual native/browser costs. The local
  same-machine idle baseline and real-hook-to-controlled-browser measurements are recorded
  in `p3-performance-verification.md`; their short sampling and external-boundary limits
  do not complete these remaining checks.
- Installer installation/upgrade smoke and remote Windows/macOS/Linux CI. The local full
  NSIS build passed; see `p3-packaging-verification.md` for zcode's earlier, narrower report.
- Human UI review and screenshot, and review of the complete diff before merge.

## Coordination

Codex committed the native handoff and packaging with normal Git, without modifying or
bypassing zcode's environment gate. External `feat/p3-packaging-ci` commit `0408738` was
integrated as `00acde7`. Only the native module and the four agreed packaging paths were
included; `.mimosa` state was excluded. The current zcode priority task is defined in
`p3-zcode-desktop-diagnosis-task.md`. Codex completed the paused program-boundary coverage
locally; see `p3-program-verification.md`. User direction is local fixes first, with no
new pushes or PR creation. No PR was created; the earlier authorized branch push completed
before the cancellation, and the remote branch remains at `3f8ea16`.
