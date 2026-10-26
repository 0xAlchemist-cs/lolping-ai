# Full Main entry-point verification

Codex, 2026-10-26. Windows 11 build 26100 x64, one display at 125% DPI.

Commands: `npm run build`, then `node tools/ping-actions-app-smoke.cjs`.
The complete built `out/main/index.js` is loaded without replacing Main's routing,
settings handlers, store, overlay/session manager, executor or lifecycle code. The
settings page, independent production preloads and unchanged real input helper run.
The harness observes actual helper output; it does not inject helper protocol events.

Both `appData` and Chromium `userData` point into a unique run directory below
`out/ping-actions-app-smoke`. Settings, API-key lookup and caches therefore use the
fixture profile, not the user's profile. The test uses a development runtime, does
not install the app or change startup registration, does not rejoin a room, and leaves
network access off through the existing setting. Other feature defaults remain intact.
Inherited lolPing test environment overrides are removed before launch.

## Explicit controlled boundaries

- `shell.openExternal` records requested URLs without opening a browser.
- The program dialog returns the current known local executable as a controlled choice.
  Real Main picker credentials, canonical-file verification and protected save IPC still run.
- Only desktop-helper process creation is redirected to an owned waiting Node child.
  Main's real DesktopBridge sends its request, times out/cancels, and kills that child.
  A probe proves the child remains alive when capture state has not changed. Arbitrary
  program launch attempts are blocked and counted.
- Keyboard and mouse input is OS-injected into the exact owned foreground window through
  the shared guarded client. Activation clicks, when needed, are excluded from assertions.

These boundaries mean this is full-Main integration evidence, not real browser launching,
native foreground activation, actual desktop restoration or physical mouse acceptance.

## Result

All 18 scenarios passed with exit 0:

1. Complete Main startup, actual settings preload and opt-in defaults.
2. Real IPC rejects question-mark bindings, raw executable paths, forged tokens and generic
   patches to protected bindings.
3. Actual Fluent editor saves through preload/IPC/store; saved enabled action can be tested
   while the feature switch is off.
4. A foreign sandboxed window cannot save, test or report a quick action.
5. Feature off preserves the ordinary wheel Ping.
6. Real Hook → InputBridge → overlay/preload → actual Main dispatch.
7. Moving the icon moves its saved action.
8. Standard question mark with AI off produces no action or AI card.
9. With AI on, the same moved question mark opens the original AI card without a model call.
10. Paused app passes input through.
11. Resume restores wheel dispatch.
12. Settings capture passes input through.
13. Closing settings clears capture and restores the real input chain.
14. Duplicate `setCapturing(false)` leaves an active controlled native job alive.
15. Closing settings cancels the waiting native child.
16. Pause cancels the waiting native child.
17. A settings change cancels the waiting native child.
18. Input still dispatches after those cancellations.

Observed totals: 8 original wheel Pings, 6 recorded URL submissions, 3 controlled native
jobs, 0 program launches, 0 Main fetch calls, 0 external renderer HTTP requests. No
desktop child is spawned for startup or web actions. Cancellation is asserted below
1.2 seconds after each real lifecycle change, distinct from the 3-second helper timeout.
The input child is observed exiting during actual Main shutdown. The launcher reads
the final saved binding after exit, confirming persistence through the real store.
The final run measured controlled-child cancellation at 44.6ms for settings close, 31.7ms
for pause and 31.6ms for a settings change. These are Main/process-cancellation observations
against the fixture child, not native activation performance or release-to-dispatch P95.

## Product bug found and fixed

KeyCapture controls announce their initial `false` capture state on mount. Main previously
processed even an unchanged value through `syncSuspended`, which also cancels pending
quick actions. Reopening settings could therefore cancel a legitimate new action when
the controls finished mounting. The deterministic regression started a waiting child,
sent `setCapturing(false)` while already false, and failed with
`duplicateCaptureNotificationCanceledAction` before the fix.

Main now ignores unchanged capture values. Real true/false transitions retain their
existing suspension and cancellation behavior. The complete 18-case run then passed;
the native child's probe response verifies the unchanged-state case rather than merely
counting IPC calls. No native input source or protocol was changed.

## Harness corrections and remaining acceptance

Early harness attempts tried reopening settings before destruction finished, or awaited
the result of JavaScript in a destroyed renderer. Those attempts timed out and were not
counted as passes. The harness now waits for destruction and inspects the owned child's
termination directly; renderer probes have deadlines. A shared driver client reuses
the same owned-window guards as the 17-case real-hook smoke.
The final driver acknowledges actual release before restoring the pointer. Its inert input
window suppresses browser drag/selection defaults without altering production UI features.

Hardware mouse, UAC/elevated targets, mixed DPI/multiple displays, secure-desktop return,
actual program/browser behavior, real desktop restoration, installer installation/upgrade,
baseline CPU/memory and full physical dispatch latency remain open. This test does not
resolve zcode's separate ToggleDesktop investigation and makes no paid API calls.
