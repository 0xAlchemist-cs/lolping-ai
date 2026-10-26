# Windows desktop helper (P3)

One-shot C++20 console child (`build/desktop-helper.exe`) for the P3 desktop actions.
It implements the protocol and ownership rules of
[docs/p3-desktop-helper-contract.md](../../docs/p3-desktop-helper-contract.md), which is the
single source of truth for the wire format. Codex owns the Electron side that spawns it.

- `activate` finds the first eligible top-level window (Z order) whose owning process image
  path equals the requested local absolute `.exe` path, restores it if minimized, and requests
  foreground activation. No window: `launchRequired`. Window found but not activatable:
  `activationDenied` (with a taskbar flash as an attention fallback).
- `toggleDesktop` calls `IShellDispatch4::ToggleDesktop` through COM. HRESULT failures come
  back as `osError` with the HRESULT in `win32` (unsigned decimal).

The helper never launches the target, never injects input, never attaches to another input
thread, and never expands command strings: an `exePath` is only compared against
`QueryFullProcessImageNameW` output.

## Build and test

```powershell
node native/desktop-helper/run.mjs build   # builds desktop-helper.exe, desktop_helper_tests.exe, fixture_app.exe (MSVC, /W4 /WX)
node native/desktop-helper/run.mjs test    # rebuild + unit tests + end-to-end tests through the real exe
```

Non-Windows: `build` exits 1 and `test` exits 0 with an explicit `Windows-only; skipped`
message. Nothing on another platform is ever reported as a Windows result.

## Layout

| Path | What lives there |
| --- | --- |
| `src/protocol.{h,cpp}` | Pure request parsing/validation and result serialization. No OS calls; unit-tested directly. |
| `src/main.cpp` | One-shot stdin/stdout framing: one LF-terminated request line in, one result line out, size caps, exit codes. |
| `src/activate.{h,cpp}` | Window enumeration, eligibility filtering, path matching, restore + bounded foreground activation. |
| `src/toggle_desktop.{h,cpp}` | COM `IShellDispatch4::ToggleDesktop` with balanced init/uninit. |
| `tests/protocol_tests.cpp` | 101 unit checks for the pure protocol layer. |
| `tests/e2e.mjs` | End-to-end checks through the real executable, including GUI fixture scenarios. |
| `fixtures/fixture_app.cpp` | Controlled GUI fixture (normal / minimized / multi / hidden / noactivate / hung / vanish) that only creates and observes its own windows. |

## Protocol decisions where the contract left room

Written down so Codex can flag disagreements instead of discovering them in code:

- Requests must be exactly `{"type":"toggleDesktop"}` or
  `{"type":"activate","exePath":"..."}` in any key order. Unknown keys, duplicate keys,
  non-string values, nested values, a missing LF, or any byte after the LF are
  `invalidRequest`. Trailing whitespace on the line is tolerated.
- A missing or non-string `exePath` is `invalidRequest`; a present string that fails the path
  rules (drive-rooted only; UNC, device namespaces, second colon/ADS, `.`/`..` components,
  forbidden characters, control characters, non-`.exe` extension, over 32767 code points) is
  `invalidPath`. Invalid UTF-8 anywhere is `invalidRequest`.
- Path matching normalizes `/` to `\`, collapses doubled separators and then compares complete
  UTF-16 paths with `CompareStringOrdinal` (ordinal, Unicode case-insensitive), so case can
  differ anywhere in the request, not only in ASCII.
- `activated` is returned only after `GetForegroundWindow()` was observed to be the target
  window; `SetForegroundWindow`'s return value alone is not trusted. The activation retry
  loop is bounded at 1.5 s so the helper never waits on a hung UI thread.
- Once a window is selected, its HWND, owning PID and complete exe path are re-verified
  before the restore request and before every foreground attempt. If the window is
  destroyed, recycled, changes process or changes path, the helper stops with
  `activationDenied` immediately (well under the 1.5 s bound); `launchRequired` is never
  returned after a selection was made.
- `desktopToggled` means the shell accepted the request (S_OK); it does not claim a verified
  physical gesture.

## Verification record

Environment: Windows 11 Pro 10.0.26100 x64, interactive desktop session, MSVC 14.44.35207
(VS 2022 Build Tools), Node 22.15.0. All commands were run from the repository root on
branch `feat/p3a-desktop-helper`.

| Command | Result |
| --- | --- |
| `node native/desktop-helper/run.mjs build` | exit 0; built `build/desktop-helper.exe`, `build/desktop_helper_tests.exe`, `build/fixture_app.exe` (clean under `/W4 /WX`) |
| `node native/desktop-helper/run.mjs test` | exit 0; unit: 92 passed, 0 failed; e2e: 27 passed, 0 failed, 0 skipped (round 1; round 2 counts: 101 unit, 32 e2e - see below) |
| second `node native/desktop-helper/run.mjs test` run | exit 0; same counts (stability rerun) |

TDD sequence: `tests/protocol_tests.cpp` was written and run against a stub `protocol.cpp`
first and failed 83 of 89 checks ("6 passed, 83 failed"); only then was the implementation
written, ending at 92/92. An end-to-end failure found a real framing bug during development:
a second request line delivered in the same pipe read as the first was executed instead of
rejected; `src/main.cpp` now rejects any byte after the request LF within the same chunk.

End-to-end coverage actually observed (through `build/desktop-helper.exe`):

- Malformed input rejected with `invalidRequest` and exit 1: empty stdin, garbage, truncated
  object, complete object without LF, two requests on one stdin, trailing garbage after the
  object, nested value, non-string value, unknown type, activate without exePath, extra
  field, request over 64 KiB.
- Size boundary: a request line of exactly 65536 bytes is parsed (and fails path validation,
  `invalidPath`); 65536+ is `invalidRequest`.
- Invalid paths rejected with `invalidPath`: relative, UNC, ADS colon, non-`.exe`.
- `launchRequired`: a syntactically valid path with no matching process.
- Real window tests with the controlled fixture (real windows on the interactive desktop):
  - normal window: `activated`, fixture independently confirmed its window became the
    foreground window;
  - self-minimized window: `activated`, fixture confirmed minimized -> restored and
    foreground;
  - two windows: `activated`, foreground confirmed;
  - hidden (never shown, tray-like): `launchRequired`;
  - `WS_EX_NOACTIVATE` window: `launchRequired`;
  - hung window (thread stops pumping): helper returned in ~170-210 ms with `activated`,
    never blocking on the target's UI thread.
- Two real `toggleDesktop` requests: both `desktopToggled` with exit 0, and a fixture window
  observed an actual minimized -> restored round trip across the two toggles (the first
  toggle's direction depends on the desktop's current show state).

The fixture scenarios need an interactive desktop; without one (for example a service
session) they are reported as `skip` with the reason, never as passed.

## Follow-up verification record (2026-10-26, round 2)

Codex's acceptance findings were addressed; see `docs/p3-zcode-followup.md` on
`feat/p3a-windows-actions` for the original brief. All numbers below are from real runs of
`node native/desktop-helper/run.mjs test` (exit 0 unless noted) in this worktree.

**1. UTF-8 above U+10FFFF is now rejected by the protocol layer.** Unit tests first failed
against the old code (3 red), then passed after the scalar bound check in `copyRawUtf8`.
Final count: **101 unit checks passed, 0 failed**. Through the real executable with raw byte
input (`Buffer` + latin1, no JS string normalization): `F4 90 80 80` (U+110000) and an `F5`
lead both answer `invalidRequest` with exit 1; the valid `F4 8F BF BF` (U+10FFFF) boundary
parses and answers `launchRequired`. Valid `U+10000`/`U+10FFFF` and apostrophe/ampersand/space
paths are covered as accepted cases.

**2. Unicode path comparison uses `CompareStringOrdinal`.** A copy of the fixture runs from
a temporary directory named with Greek/Cyrillic letters (`p3ΔЙДΩ`); the request spells the
directory in the other case (`p3δйдω`). Observed `activated` with the fixture confirming
foreground in a permission-granted session, and `activationDenied` (window matched, activation
refused by OS policy - a match failure would have answered `launchRequired`) in a
permission-denied session. Both outcomes prove the Unicode case-insensitive match. The
fixture copy and its directory are removed afterwards.

**3. Window identity is revalidated before restore and before every activation attempt.**
The selected HWND, PID and complete exe path are re-checked (`IsWindow`, eligibility,
`GetWindowThreadProcessId`, `QueryFullProcessImageNameW`) on every loop iteration. Evidence:
a `vanish` fixture mode destroys its own window synchronously inside the activation message,
so the helper's next identity check sees a dead handle. Observed `activationDenied` in
64-83 ms (an order of magnitude under the 1.5 s timeout walk; before the fix the same
scenario walked the full timeout). The guard passed 45 consecutive checks in a diagnostic
run against a live window, so it does not misfire on healthy windows.

**Foreground permission observation.** Windows restricts foreground activation based on
several foreground/input conditions. The lolPing overlay is non-focusable and click-through;
holding its trigger does not focus lolPing or automatically grant the separate desktop
child permission. This test harness can also lose foreground rights when its terminal
loses focus. A canary
activation probes the state: when granted, steal scenarios assert `activated` plus the
fixture's own foreground confirmation; when denied, they assert `activationDenied` for the
matched window (still proving the match). Restoring a minimized window follows a different
rule and consistently activates in both states. Both suite states passed:
- permission-denied session: 32 e2e passed, 1 skip (the canary probe itself), 0 failed
- permission-granted session: 33 e2e passed, 0 failed, 0 skipped, including the
  `minimized -> restored` round-trip observation across the two toggles (the shell-state
  sensitivity described below had cleared by then; both behaviours were recorded)

**ToggleDesktop effect observation.** Every run of the two mandated toggles answers
`desktopToggled` with exit 0. In the morning session the fixture window observed a real
`minimized -> restored` round trip across the pair. Later the same day, in the same Windows
session, the shell accepts every toggle (S_OK) but no longer changes window states at all -
verified manually with both a visible and a self-minimized fixture window, including after
an unpaired toggle. The cause was not established by this observation.
`desktopToggled` means the request was accepted, not that a gesture was verified. Re-check
on a fresh session is a manual item. A run without the window-level round trip now reports
that effect check as SKIPPED, separately from its passing request/response checks. It must
not be described as completed desktop or hardware-gesture acceptance.

Codex acceptance also reproduced the foreground-denied outcome in both Node and Electron
hosts, with hidden and non-hidden desktop children. The Electron wheel/native smoke remains
separate from the native protocol/window suite and has not passed its complete desktop
round-trip assertion at this checkpoint.

## Not verified here (manual / Codex acceptance items)


- Hardware mouse and full lolPing wheel integration (Codex owns the Electron-side proof).
- Elevated (UAC) target windows from a non-elevated helper: `SetForegroundWindow` may be
  blocked by UIPI; the expected result is `activationDenied` with a taskbar flash, but no
  elevated-target scenario was automated.
- Mixed-DPI multi-monitor placement: the helper does not use coordinates, but no multi-DPI
  run was performed.
- Non-Windows platforms: only the explicit skip path exists; no cross-platform run.
- Concurrent desktop-state changes (user pressing Win+D while the helper toggles).
- ToggleDesktop window-level effect on a fresh Windows session (see the shell-state finding
  above); acceptance is verified, the end-to-end gesture is a manual check.

## Known limitations

- `launchRequired` is returned when the window cannot be proven to match (for example a
  protected process that cannot be queried); it does not distinguish "no window" from
  "window not visible to this process".
- The taskbar flash fallback may be suppressed by focus-assist settings.
- The identity guard binds HWND + PID + exe path. A PID reused by a different executable is
  rejected by the path check; a PID reused by another instance of the same approved
  executable is indistinguishable from the original and would still be a valid activation
  target for that approved path.

## Commit status: blocked by the environment's commit gate (recorded 2026-10-26)

All work is complete and verified in this worktree, but `git commit` is blocked by the
Mimosa L3 pre-commit gate in this environment: it scans the whole project on every commit
and hard-blocks on two pre-existing high-severity findings in baseline files that this
branch does not touch and that this branch is not allowed to touch (Codex/maintainer
ownership per the contract):

- `src/main/captureWindows.ts:14` [high] untrusted program selection (env-chosen execFile)
- `src/main/windowsFrame.ts:28` [high] untrusted program selection
- `src/main/index.ts:105` [medium] cross-file taint (advisory)
- `tools/extract-assets/emote_bake.py:729` [low] insecure randomness

A focused Mimosa scan (`scan-2026-10-26T02-04-12.827Z-27a2f75a6a17`, seal
`sha256:c09680ac…4ded`) reports **zero findings in `native/desktop-helper/**`**; the gate
blocks regardless because the baseline findings remain in the working tree. `--no-verify`
does not help (the gate is not a git hook). Nothing in this branch was modified to work
around the gate.

Intended commits once the gate is resolved (each path list is complete):

1. `feat(helper): add desktop helper protocol layer with unit tests` —
   `native/desktop-helper/.gitignore`, `src/protocol.h`, `src/protocol.cpp`,
   `tests/protocol_tests.cpp` (currently staged)
2. `feat(helper): implement one-shot desktop helper executable` —
   `src/main.cpp`, `src/activate.h`, `src/activate.cpp`, `src/toggle_desktop.h`,
   `src/toggle_desktop.cpp`
3. `test(helper): add gui fixture and end-to-end tests for the desktop helper` —
   `build.cmd`, `run.mjs`, `fixtures/fixture_app.cpp`, `tests/e2e.mjs`
4. `docs(helper): record desktop helper verification evidence` — `README.md`
