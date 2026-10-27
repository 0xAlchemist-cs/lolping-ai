# Fork release readiness

Date: 2026-10-27. Target: 0.6.0. Repository: `0xAlchemist-cs/lolping-ai`.

This follows the user's four requested closeout items after P3 merged. It records
observed results separately from physical acceptance and publication.

| Item | Implemented behavior | Verification status |
| --- | --- | --- |
| Update channel | Windows explicitly selects the fork GitHub feed; package metadata, macOS API and release-note fallback use the same repository | 64 update/config tests passed; actual installer feed verified; public release not published |
| Login start | Packaged Windows startup repairs missing/current-path registrations. OS-disabled entries stay disabled; an explicit enable can re-enable them. Settings write only after the OS change succeeds | 7 synchronization tests and 2 settings transaction regressions passed; installed-app API confirms enabled registration; actual login pending |
| Release/compatibility | 0.6.0 metadata; Release pipeline gates Windows native checks/package validation and waits for Windows/macOS/Linux artifacts | 1,431 app tests, production build, 10 preload checks and actual upgrade passed; user confirmed 100/150/200% single-screen checks; three-platform CI passed for 22b5956; remaining physical matrix pending |
| System program paths | Capture composition and dark-frame operations use fixed bundled-native DWM requests, removing both environment-selected PowerShell launches | Poisoned-SystemRoot regressions passed; 114 native protocol checks, 15 hidden-command checks and 4 real hidden-window DWM checks passed |

## Update destination

`src/shared/project.ts` defines the fork URLs. Windows sets the provider explicitly
instead of relying only on a potentially old `app-update.yml`. Localhost update and
renderer development-server overrides are now limited to unpackaged development;
installed builds ignore those environment variables. No API key or room data is part of update
requests, and no paid AI API is used by validation.

The lockfile changes only the root package versions. Dependencies are unchanged.
The existing application ID and settings location stay compatible with the installed
lolPing profile; this does not introduce parallel upstream/fork installations.

## Login start

`getLoginItemSettings` uses the same executable and `--hidden` arguments as the
registration. Readback is checked after writes. A system refusal returns a localized
settings error and leaves the saved settings patch unapplied. Startup reconciliation
is Windows-only; existing macOS/Linux mechanisms are retained.

An entry absent from both Run and the startup directory while settings requested
startup reproduced the local delivery mismatch. A real login/restart is a separate
physical check; a registry entry alone is not recorded as proof of login execution.

## Fixed native operations

`flushComposition` has no arguments. `styleWindow` accepts only positive bounded
decimal-string HWND and owner PID fields, verifies window ownership before and after
styling, and invokes a fixed `DwmSetWindowAttribute` operation. There are no script,
DLL, function, executable-path or free-form command parameters. Requests remain flat,
bounded and single-use. Main runs only the bundled helper, with a five-second limit
and child cleanup. Main also cancels all pending system tasks on graceful exit and
rejects tasks after shutdown starts (two lifecycle regressions). The input helper and
its protocol are unchanged.

The hidden-window test used an actual native helper with `SystemRoot` and `windir`
set to `Z:\untrusted`. Styling, foreign-PID refusal and composition flushing passed;
the fixture never became foreground. This closes the two reviewed command-path
findings; it is not a whole-repository security certification or an external Mimosa
rescan. The latter tool is not exposed in this session.

## Acceptance matrix

| Check | Current evidence |
| --- | --- |
| Main update/build tests | 1,431 passed / 91 files; typecheck and production build exit 0 |
| Production preload and package | 10 passed; both helpers present, 226 production archive entries, no fixture/smoke artifacts |
| Original input helper | 542 passed |
| Native protocol | 114 passed, zero failed |
| Hidden fixture command safety | 15 passed; no input injection or desktop actions |
| Native DWM capability | 4 passed; actual hidden owned window and poisoned environment |
| Strict desktop-helper suite | 41 passed, zero failed/skipped; actual repeated one-way minimize effects |
| Complete built Main | 18 scenarios passed with real Hook, saved settings and sandbox preload; URL requests and activation boundary controlled; graceful input exit verified |
| Actual screenshot and native frame | Capture/exclusion smoke and guarded OS resize smoke passed; real native dark frame applied; one actual 125% display |
| Synthetic AI regression | Vision 6 requests and diagnostics 10 cases passed; no external service or paid API |
| Clipboard and Fluent inputs | 30 synthetic answers plus focus/competing-writer checks passed; 6 real Fluent saves preserved Unicode, editing and older-reply behavior |
| User's real Alt clear | User confirmed every repeated clear succeeded on the prior P3 package |
| 0.6.0 installer + 0.5.3 upgrade | Both real NSIS installers exited 0; version verified using app manifest/FileVersion; settings and encrypted key bytes unchanged from before both installs |
| Installed login registration and hidden launch | Installed app started with `--hidden`; actual Electron readback reports openAtLogin=true, executableWillLaunchAtLogin=true and enabled own user entry |
| Final 0.6.0 replacement | Reinstalled the final build; actual local Settings and enabled status observed while the Main process inherited a poisoned renderer URL; used the existing second-instance settings entry point |
| Actual log-out / log-in | Pending user execution; user explicitly deferred until a later normal restart/login |
| Real input combinations and side buttons | Prior controlled-hook coverage exists; full physical matrix remains pending |
| Single-screen 100/150/200% DPI | User reported all requested checks passed at all three scales on the installed 0.6.0 build (2026-10-27); detailed scope below |
| Mixed-monitor DPI and external display | Not tested: user has no external monitor; single-screen scaling does not establish these results |
| Lock/unlock return | User reported Alt wheel, website action and clearing all normal after Win+L and unlock on installed 0.6.0 (2026-10-27) |
| UAC prompt return | Not manually tested; user explicitly waived this check for this delivery on 2026-10-27. It is not a delivery blocker or a recorded pass |
| Elevated target windows | Not verified; the waived UAC prompt-return check does not establish activation behavior for elevated targets |
| Long run and physical P95 | Pending; previous controlled performance evidence stays in `p3-performance-verification.md` |
| Current full-Main dispatch measurement | 100 real-Hook samples; P50 5.47 ms, P95 7.05 ms, max 11.12 ms at the controlled browser-request boundary; hardware/browser/native costs excluded |
| Current same-machine idle comparison | 40/40 ABBA intervals plus 10/10 configured-enabled intervals; one input helper and zero desktop-helper launches in all trials; details in `p3-performance-verification.md` |
| New three-platform CI | [Run 40420471024](https://github.com/0xAlchemist-cs/lolping-ai/actions/runs/40420471024) passed Windows, macOS and Linux tests and packaging on exact head `22b5956815af11243a37782ecb801bba95ba879c`; latest branch checks are on [Draft PR #7](https://github.com/0xAlchemist-cs/lolping-ai/pull/7) |
| Public Release pipeline | Tag-triggered publish workflow not run; no public release. [Bilingual draft release notes](releases/0.6.0.md) are ready for review |

No missing physical check is counted as a pass, and no public release is recorded
until the corresponding publish result has been observed.

Final local installer: `lolPing-Setup-0.6.0.exe`, 171,861,012 bytes, SHA-256
`ec9e9e8ad1781916c459d05d658fe23b155982322a1772dd27ad4f29b6c32966`.
Its SHA-512 matches the generated `latest.yml`. This is an unsigned local artifact,
not a record of public publication. The poisoned-environment installed run initially
exposed a second dev-URL check disabling protocol serving; the shared path selector
now controls both page URLs and protocol serving, with a red/green regression and a
successful installed-app recheck. A first-window-handle assumption in the local
verification script was also corrected: the overlay may be chosen before Settings.

## Single-screen acceptance procedure

Result (2026-10-27): after being asked to test each of 100%, 150% and 200% on the
installed 0.6.0 build, the user replied "都没有问题" (no problems with any of them).
This is user-reported physical acceptance, not an automated observation or a timed
latency measurement. The requested checks were:

| Scale | Wheel at center/edges and selected action | Websites/programs and repeated clearing | Local screenshot alignment | Esc/right-click/center cancellation |
| --- | --- | --- | --- | --- |
| 100% | User passed | User passed | User passed | User passed |
| 150% | User passed | User passed | User passed | User passed |
| 200% | User passed | User passed | User passed | User passed |

Procedure: change Windows Settings > System > Display > Scale, then test the
installed app at each scale:

1. Alt + left drag: check wheel position and highlighted direction near the center
   and edges of the screen; release and compare the selected Ping/action.
2. Trigger a saved website and a saved program, then clear, reopen an ordinary
   window and clear again three times. The question mark stays AI-only; no paid
   request is required.
3. Open the question card's local screenshot preview without uploading; check the
   crop aligns with the Ping and excludes lolPing windows.
4. Test center release, Esc and right-click cancellation. Pause/resume and ordinary
   dragging remain separate checks; they were not part of this DPI confirmation.

Record each scale independently and restore the user's original 125% afterward.
This cannot establish mixed-DPI or external-display acceptance. In a separate
Win+L check on 2026-10-27, the user confirmed the Alt wheel, website action and
clearing all worked normally after unlock. The user subsequently waived UAC
prompt-return testing for this delivery; its result remains unverified. Actual
login start was deferred to a later normal login. Neither result is inferred from
the successful lock/unlock test.
