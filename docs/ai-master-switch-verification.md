# Windows AI master-switch fix

Date: 2026-10-28. Baseline: `407be685d9af6bfc7cbffd5f3d685c6e6432fb6b`.

The user reported an AI question card after turning Quick actions off. The saved
profile had `quickActions=false`, `aiExplain=true`: the old wheel listener checked
only the AI preference. The user explicitly chose unified control on Windows.

## Behavior

- Windows question-mark AI requires both Quick actions and AI explain.
- Turning either effective switch off closes the question card and cancels its
  active request. The existing close path invalidates temporary screenshot state.
- Turning Quick actions back on restores availability if the AI preference remains
  enabled. The AI preference, endpoint, model, encrypted key and bindings are retained.
- The question mark remains reserved for AI; its normal Ping still fires while AI
  is unavailable. Explicit tests of saved ordinary actions retain their existing rule.
- macOS and Linux keep their independent AI preference. The extra settings hint is
  displayed only on Windows. Input-helper sources/protocol and wheel art are unchanged.

`aiExplainOn` is the shared effective predicate. Main uses it for wheel card creation,
request/configuration availability and the settings-change close/cancel transition.
The underlying saved feature preferences are not mutated by that predicate.

## Evidence

| Check | Result |
| --- | --- |
| Policy regression before fix | Windows AI=true / Quick actions=false failed as expected |
| Complete old Main regression | Failed at `masterOffKeptAiCard`, reproducing the reported behavior; input helper exited |
| Policy checks after fix | 14 passed, including all four Windows combinations, no preference mutation and macOS/Linux behavior |
| Full application tests | 1,437 passed / 91 files |
| Typecheck | Exit 0 |
| Original input-helper tests | 542 passed |
| Full built Main / real Hook | 22 scenarios passed, including master-off card closure, no new popup, re-enable and the independent AI off switch |
| Streaming cancellation | One controlled synthetic fetch started and one abort was observed on master-off; model/base/key survived and availability returned on re-enable |
| Actual Fluent UI | Passed: three saves, two saved tests, three picks, one removal, both languages; unsupported feature/hint hidden on macOS/Linux |
| Production build / installer | Exit 0; both helpers present, 226 production archive entries and no test artifacts |
| Production sandbox preload | 10 passed |
| Installed replacement | Installer exit 0; app archive and both helpers match the fresh package byte-for-byte; compiled Main contains both effective-switch guards |
| Personal configuration | Settings and encrypted key bytes match pre-install backups; all seven enabled bindings retained; original running state restored |
| Actual installed settings | New Windows-only master-switch hint observed in the installed Settings window |

The streaming check uses a fixed fake loopback endpoint and a synthetic key in an
isolated encrypted key store. It replaces fetch with an in-memory response; no
real HTTP request or paid API call is made. URL opening and activation boundaries
remain controlled. These are guarded injected-input tests, not hardware-mouse or
cross-platform physical acceptance.

The UI regression initially caught the Windows-only hint appearing on other
platforms. The hint now has a platform condition, and the same UI check passed.
Mock integration setup also caught header-case and function-cloning mistakes in the
test tooling; these were corrected without changing production request safeguards.

Local raw logs/reports are ignored under `out/ai-master-*.log` and the unique
`out/ping-actions-app-smoke/run-*/report.json` generated for this run. The original
red result remains `out/ai-master-red-main.log`.

The installed-state probe initially ran before the single-instance settings window
was available. A bounded recheck after startup found the owned window and confirmed
the original enabled state. No reinstallation or preference reset was needed.

Local fixed installer SHA-256:
`c4f93c1ebdbd0f1b5967ad88c083a364c989bf0a86ebb7383573ad1846553c5f`.
Version remains 0.6.0; no tag or public Release was created.
