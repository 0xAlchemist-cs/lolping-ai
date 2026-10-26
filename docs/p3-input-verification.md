# Real-hook integration checkpoint

Codex, 2026-10-26. Command: `node tools/ping-actions-hook-smoke.cjs`.
Requires a production app build and an existing Windows input-helper build. It is an
explicit local interactive test, not an unattended CI job.

## What ran

The test runs the unchanged real `hook-helper.exe` (no `--simulate`), `InputBridge`,
`OverlayManager`, production overlay renderer and sandbox preload, and `QuickActionExecutor`.
Only the input helper's stdout events are routed to the manager. The script never calls
`manager.handle` with synthetic wheel events. A fixed test binding table and availability
callback stand in for the full Main entry point; settings go through production
`normalizeSettings` and `configCommand`. The executor's URL open operation is a local
recording stub. No webpage, program or desktop action is opened.

`ping-actions-hook-input.ps1` sends test-only OS keyboard/mouse input. It checks the HWND/PID
and that both gesture points belong to that exact root window, raised above other apps.
If foreground activation was refused, a separately counted unmodified click activates only
the verified empty area of the owned fixture. The harness waits for that click to reach
the fixture and resets the pointer-event baseline before testing pass-through, so an
activation click cannot make a broken gesture check pass. Before the trigger gesture it
checks actual foreground and ownership again. Already-held modifiers/buttons, covered
surfaces and lost foreground cause failure rather than input to another application.
Bounded ready/start, armed/press, held/release and released/restore handshakes avoid timing sleeps and
release input if the parent stops responding. The driver restores the pointer and the
harness stops only its own helper and windows. It never changes global foreground policy.
Pointer restoration waits for an actual helper release/cancel or a passed-through mouse-up.
The input sink has no menu and prevents its own browser selection/drag defaults; only actual
mouse events increment the counters. It shares `ping-actions-input-client.cjs` with the
separate full-app smoke, without sharing any production preload runtime module.

The observed display was 2560×1600 at 125%. Results do not cover other DPI values.

## Result

All 17 controlled cases passed (exit 0):

- Ordinary click pass-through.
- Alt, Ctrl and Shift wheel gestures.
- Mouse side buttons 4 and 5.
- Standard question mark produces the original wheel report, without an action.
- Center, Esc and right-button cancellation.
- Single-click Ping produces its existing shared Ping, without a wheel action.
- Settings capture suspension passes input through; the next gesture works after resume.
- Quick-actions switch off and individual binding disabled both preserve the original Ping.
- Swapping wheel positions executes the moved icon's saved target.
- Paused input passes through without an action.

Counts: 11 real helper wheel releases, 10 original wheel Pings, 11 original shared Pings
(including the click Ping), 7 recorded action submissions, 0 external HTTP requests.
The latest final run passed all 17 cases and reported 1 separately counted setup activation
click, excluded from pass-through assertions. Earlier successful runs needed none. The driver waits at most
one second for pre-existing button/modifier state to clear naturally; it never forces
those keys up. The fixed C# driver is compiled once into a source-hashed DLL under the
ignored smoke output directory and reused by subsequent driver processes. Changing the
script changes that cache key; no fixture DLL is shipped in the application package.

Repository-required regression checks were rerun during this work: TypeScript exit 0,
1414 Vitest checks in 87 files passed, and the unchanged input helper passed 542 checks
with the already documented local MSVC flags.

## Test setup failures fixed before acceptance

The first guarded attempt found another desktop window covering the owned input target;
it refused input. Raising only the fixture resolved the test setup issue without changing
production overlays or weakening the guard. A later attempt consumed the Alt press but
emitted no wheel open when the driver only repositioned the cursor. Explicit noncoalesced
`SendInput` movement produced the actual hook movement events. Finally, assigning Ctrl
directly to a raw fixture configuration conflicted with the existing Ctrl emote trigger;
using the production normalizer applied the existing conflict rule and removed the test's
invalid configuration. These were harness corrections, not production fixes.

A subsequent launch timed out while waiting for `requestAnimationFrame` in the covered
fixture, before sending input. A three-second frame deadline reproduced that exact wait;
disabling background throttling only on the fixture removed it. Further runs reported
actual Windows foreground denial, despite the Electron focus flag. Plain focus requests
and minimizing/restoring the fixture did not establish the precondition and were not
treated as passes. The guarded activation-click handshake above then completed all 17
cases again. The earlier timeouts and denied attempts are not hardware/input acceptance.
One faster cached-driver attempt stopped with `userInputHeld` before the next trigger;
the bounded state-clear wait above subsequently completed all 17 cases without forcing
any input release. Failed guarded attempts were never treated as a successful matrix.
During the full-entry-point work, one final attempt selected an unexpected icon and a
release-acknowledgement attempt stalled on the fixture's browser drag behavior. Those runs
failed. The inert sink and explicit release-before-restore handshake above then passed both
the complete 17-case hook matrix and 18-case full-app matrix. Hardware acceptance is still open.

## Remaining limits

This verifies the real hook/core overlay integration with **OS-injected input**, not a
physical mouse. It does not boot the complete `src/main/index.ts` app entry point or prove
all of its lifecycle wiring. The separate `p3-full-app-verification.md` checkpoint now
covers that complete entry point with controlled external effects. Foreground activation,
actual desktop restoration, UAC,
lock screen, multi-monitor/mixed DPI, successful browser/process startup, complete
CPU/memory/performance acceptance and installer upgrade remain separate checks. Existing
AI question-mark reporting is preserved, but no real model was called.

The desktop helper was not spawned, so this test does not claim to resolve or accept
zcode's separate desktop-effect investigation. No production input source/protocol,
application source, release configuration or user settings were changed.
