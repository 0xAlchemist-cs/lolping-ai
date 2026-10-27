# P3 local performance checkpoint

This opening checkpoint is historical (2026-10-26). The current 0.6.0 follow-up is
recorded at the end of this document. References below to unresolved restoration,
no installation or no PR describe that older checkpoint; clearing is now one-way.

Date: 2026-10-26. Windows 11 build 26100 x64, AMD Ryzen 7 8845HS, 16 logical processors.
Launcher Node: 22.15.0. Measured Electron: 44.5.1, embedded Node: 24.21.0.

This records an actual built-Main comparison and a scoped real-hook latency test.
It does not accept physical-input performance, application activation, browser startup
or the unresolved desktop restoration behavior.

## Baseline and isolation

Baseline: `34f0e070500fbbbabfd24ba75b8c6008ce13f0e6`.
Current production source: `42563c233407eba02aef30eefcabe745d547532a`.
The baseline was exported with `git archive` into ignored
`out/p3-performance/baseline-34f0e070`, built there, and typechecked. Its existing
81 test files / 1345 tests passed. Old worktrees and branches were untouched.

Both builds reuse the installed dependency tree. Their `package-lock.json` SHA-256 is
`7e35cea056b9ebffa3631c0d97c7ee22697fcecd34766d36ce27c0c257cb68da`.
Input-helper source/protocol are unchanged between these revisions; both runs use the
same verified binary, SHA-256
`40ced7778912a0024fcd2cb2ed9dd4b3c630f389defb0572a1b4e9e40ebd7945`.

Each run loads its actual built Main entry with separate appData and userData, offline
room settings, no rejoin, muted sound, no updater or startup registration, and no open
settings window. External browser/program requests fail closed. The real input helper
runs normally. The benchmark sampler is test tooling, outside the measured process set.

## Idle CPU and memory

`tools/ping-actions-idle-benchmark.cjs` runs baseline/current/current/baseline (ABBA).
After startup and sampler initialization, each run warms up for five seconds and samples
ten roughly one-second intervals. The process set is Electron's `getAppMetrics` PIDs plus
the owned input helper, six processes in every accepted interval. PID creation times
must remain unchanged; unrelated processes and window contents are not inspected.

An interval qualifies only when the session's last-input timestamp is unchanged and
input was already at least five seconds old at its beginning. The session-specific
scope follows [GetLastInputInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo).
Insufficient idle samples produce `INCOMPLETE`, null idle aggregates and exit 1.
Raw cumulative CPU/memory snapshots, input timestamps and accepted/excluded intervals
remain in the generated report.

CPU is the summed change in process
[TotalProcessorTime](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.totalprocessortime)
divided by elapsed wall time. The table uses percent of one logical core; divide by 16
for percent of this machine's total logical capacity. Memory is the sum of process
[working sets](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.workingset64)
and [private allocations](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.privatememorysize64).
Working-set sums can count shared pages more than once; private allocation is not
resident physical memory. These are short local observations, not a statistical claim
about all machines or a unique-physical-memory measurement.

| Configuration | Accepted intervals | Mean CPU, one core | Median working-set sum | Median private allocation |
| --- | --- | --- | --- | --- |
| Approved baseline | 20 / 20 | 1.604% | 523.66 MiB | 355.21 MiB |
| Current, default feature off | 20 / 20 | 1.759% | 524.10 MiB | 357.42 MiB |
| Current, enabled with a saved web binding | 10 / 10 | 1.172% | 523.70 MiB | 358.43 MiB |

The default-off comparison observed +0.155 percentage points of one core (about
+0.0097 percentage points of whole-machine capacity), +0.44 MiB of summed working set
and +2.21 MiB of private allocation. The enabled case is a separate single trial, not
another ABBA comparison. CPU time is coarse at these short intervals; do not interpret
the enabled trial's smaller number as a performance improvement.

All five accepted runs had one input helper, zero desktop-helper launches, zero external
requests and observed input-helper exit on shutdown. The configured trial seeds a valid
enabled `omw` HTTPS binding but never invokes it.

Artifacts, relative to this worktree:

- `out/p3-performance/idle-olGmQ4/summary.json`: successful ABBA comparison, exit 0.
- `out/p3-performance/idle-HpNy2s/summary.json`: configured/enabled idle trial, exit 0.
- `out/p3-performance/idle-7fVDnj/summary.json`: earlier incomplete attempt, exit 1;
  all 40 intervals excluded because session input remained active.

## Real-hook release to browser-request boundary

`node tools/ping-actions-app-smoke.cjs --latency` uses the complete production Main,
settings preload/IPC/store, unchanged native input helper, overlay/preload and executor.
The existing guarded driver injects 100 Alt/left-drag gestures only into its exact owned
foreground window. It retains HWND/PID, covered-surface, held-input, cursor-position and
release-before-restore checks. No synthetic helper events or alternate routing are used.

The start timestamp is taken by a stdout line reader registered before InputBridge's
reader, when Main receives a real `wheelRelease`. The end timestamp is entry to the
controlled `shell.openExternal` boundary for that release's saved web action. Each
release can contribute one sample. This includes production selection, IPC validation
and web-action dispatch, plus observer overhead. It excludes physical input, hook/pipe
delivery before Main receipt, actual browser opening/loading, native child startup,
application filesystem checks and desktop effects. It is a warm-path web-dispatch test.

The first successful run recorded 100 samples, P50 **7.81ms**, P95 **9.47ms**, maximum
**11.26ms** (nearest-rank percentiles). It observed 102 original wheel Pings and 102
controlled URL calls: the 100 measured actions, one warm-up action and one explicit
saved-action test, with the global-off wheel still sending its Ping. There were no
native activation jobs, program launches, HTTP requests or paid API calls. The real input
helper exited and the saved binding persisted after Main shutdown.

Artifact: `out/ping-actions-app-smoke/run-qy0D1i/report.json`. The raw 100 durations and
measurement scope are retained. A P95 below 100ms at this controlled boundary does not
complete the plan's full hardware release-to-system-request acceptance.

The final tool revision was rerun after adding streamed progress and bounded checkpoint
output. Another 100 samples passed: P50 **6.16ms**, P95 **8.30ms**, maximum **10.20ms**,
with the same 102 Pings/102 URL-call accounting, zero external effects, persisted settings
and observed helper exit. This run used one explicitly counted setup activation click
inside the owned fixture; the first successful run needed none. Artifact:
`out/ping-actions-app-smoke/run-fXQHao/report.json`. Both runs are retained; their samples
are not pooled into one percentile.

The ordinary full-Main invocation then passed all 18 lifecycle scenarios. Its owned
waiting-child cancellation measurements were 23.5ms for settings close, 31.0ms for pause
and 29.8ms for a settings change. Required current checks also passed in this session:
`npm run typecheck`, 1414 Vitest tests / 87 files, and 542 original helper unit checks
with the existing `CL='/utf-8 /Zc:preprocessor'` flags. No native input source was edited.

## Earlier failed attempts and remaining checks

Before the successful retry, two guarded latency runs failed before collecting samples
at `featureOffPreservesPing`, with `cursorMoveNotObserved` offsets `708,468` and `870,512`.
The idle sampler independently observed continuing session input. The user confirmed
another tool was controlling the mouse, then explicitly asked to retry. The quiet retry
passed without changing the production input code, weakening the guards or counting
the failed attempts as passes.

Hardware mouse, cold first action, real browser/program/native request costs, sustained
actions/failures/timeouts, UAC, mixed DPI, multiple displays and secure-desktop return
remain separate checks. These measurements do not resolve zcode's desktop-effect task.
No push, PR, installation, version change or release was performed.

## Reproduction

First export and build the approved baseline in an ignored directory, reuse the same
installed dependencies, and copy the current unchanged input-helper binary into that
export's `native/hook-helper/build`. Do not rebuild an old worktree in place. Verify
source revision and dependency/binary hashes before comparing. Build the current app.
With other desktop input tools stopped, run these commands sequentially from the root:

```powershell
node tools/ping-actions-idle-benchmark.cjs out/p3-performance/baseline-34f0e070
node tools/ping-actions-idle-benchmark.cjs --enabled-only
node tools/ping-actions-app-smoke.cjs --latency
```

Do not run input injection alongside idle sampling. Outputs go to unique ignored run
directories. The latency launcher streams progress every 20 samples and preserves raw
values in its report; its ordinary invocation retains the separate lifecycle regression.

## 0.6.0 follow-up (2026-10-27)

Functional source: `ba2cf4c`, with documentation at `22b5956`. Windows 11 build 26100,
16 logical processors, Electron 44.5.1. No production instrumentation or input-helper
source changes were added for these runs. The dependency graph matches the approved
baseline except for the two root version fields. Both idle variants used the same
current input-helper binary, SHA-256
`530e8152c267ab571924681ddd4bc06b0e52577dc44341379d5c121391d298bd`.

The full-Main latency run passed with 100 distinct real-Hook releases, 102 Pings and
102 controlled URL calls including setup/manual-test calls. Nearest-rank P50 was
**5.47 ms**, P95 **7.05 ms**, maximum **11.12 ms**. Two guarded activation clicks
were counted inside the owned fixture. There were zero program launches, activation
jobs or external HTTP/API requests; input exited and settings persisted on shutdown.
The scope remains Main receipt of `wheelRelease` to the controlled browser-request
boundary. It excludes hardware/pipe delivery, real browser startup, application
checks and desktop effects; it does not pass full physical-input P95 acceptance.

The baseline/current/current/baseline idle comparison accepted every interval. An
additional configured-enabled trial also accepted every interval:

| Configuration | Accepted intervals | Mean CPU, one core | Median working-set sum | Median private allocation |
| --- | --- | --- | --- | --- |
| Approved baseline | 20 / 20 | 1.575% | 523.59 MiB | 353.36 MiB |
| 0.6.0, default feature off | 20 / 20 | 1.420% | 521.22 MiB | 354.96 MiB |
| 0.6.0, enabled with a saved web binding | 10 / 10 | 1.192% | 520.65 MiB | 355.06 MiB |

The off-state comparison observed -0.155 percentage points of one-core CPU,
-2.37 MiB of summed working set and +1.60 MiB of private allocation. These short
observations do not establish a performance improvement or a long-run leak result.
The enabled case is a separate single trial. CPU uses one logical core as 100%; the
working-set sum can include shared pages more than once, and private allocation is
not resident memory. All five trials observed exactly one input helper, zero desktop
helper launches, zero external requests and input-helper exit on shutdown.

Current artifacts (ignored, relative to this worktree):

- `out/ping-actions-app-smoke/run-7anqLz/report.json`: 100 raw latency samples, exit 0.
- `out/p3-performance/idle-lOsrHy/summary.json`: ABBA comparison, exit 0.
- `out/p3-performance/idle-UWK6ct/summary.json`: configured-enabled trial, exit 0.

No installed lolPing instance was running when the tests began or ended. All test
instances used isolated profiles; no installed-app toggle or user settings were
changed. Physical input, long runs, cold launches and UAC/elevated-window cases stay
open. Single-screen DPI and lock/unlock acceptance are recorded separately in
[release readiness](release-readiness.md).
