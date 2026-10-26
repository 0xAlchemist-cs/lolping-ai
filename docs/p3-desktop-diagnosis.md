# P3 ToggleDesktop no-effect diagnosis (zcode, 2026-10-26; revised after Codex review)

Codex integration note: the current fixture has no keyboard injection commands. Earlier
`wind`/`alt` observations are reported history, not current test capabilities. Codex also
fixed physical-line parsing after reproducing a 70-byte rejection-count failure; see the
integration checkpoint near the end.

Task: `docs/p3-zcode-desktop-diagnosis-task.md`, revised per
`docs/p3-zcode-diagnosis-review-task.md` (both on `feat/p3a-windows-actions`). Scope
honored: only `native/desktop-helper/{src/toggle_desktop.cpp, tests/e2e.mjs,
fixtures/fixture_app.cpp, README.md}` plus this file. `src/toggle_desktop.cpp` was **not
modified** - the failure was not reproduced as originating in that code, and no safe
supported fix was established inside it. Everything ran on the live shared desktop of this
machine (Windows 11 26100 x64): the state flaps on a minutes scale, the user's own usage
interleaves with every experiment, and single-variable isolation was not possible. That
limits every conclusion below to what the recorded observations support.

## What the observations support (and what they do not)

Best-supported explanation: a Windows **shell show-desktop state/bookkeeping desync**. It
explains every primary observation below. It is a supported hypothesis, not a proven
internal mechanism: no Explorer internals were inspected, no trace was taken, and a live
shared session cannot exclude unknown concurrent factors.

Observations that any explanation must cover (all primary output, recorded as seen):

1. `IShellDispatch4::ToggleDesktop` returned S_OK/`desktopToggled` with no window-level
   change for minutes at a stretch - from the helper, from PowerShell, and (in earlier
   native runs) without any Electron component present.
2. OS-injected Win+D (test-only, guard-rejected rules came later - see the revision note)
   sometimes minimized the owned fixture while a second injection did not restore it, in
   the same minutes when COM toggles no-oped; at other times COM toggles worked both ways
   while an injected Win+D restore half stayed dead. Caveat: injected events are synthetic;
   Windows may drop them, and none of this is a physical-gesture proof. The two paths
   were observed diverging in the same minute, which is evidence they are not one path.
3. The shell's `MinimizeAll()` / `UndoMinimizeALL()` pair changed window states in every
   probe that called them (e.g. census `minimized 0 -> 3 -> 0`), including while the
   toggle paths no-oped.
4. The wedge direction varied: some periods dead in both directions, some periods with
   only the restore half dead, some fully healthy; transitions happened between probes
   without a controlled input.

Caller-side conditions actually checked (and their confounds):

- A granted foreground-steal canary was observed together with a no-effect COM pair -
  but the canary measures a different API's permission, and the canary probe itself
  spawns and activates a window, perturbing the desktop right before the measurement.
- A helper pair run while a fixture window had been activated to foreground (its
  backgrounded-node caller) worked in the healthy period. Confounds: the "foreground"
  event was one-time and not re-checked at toggle time, and several fixtures shared one
  exe path so the activation request could have selected a different instance. The
  revised diagnostics remove these confounds (unique-path fixture copy plus a
  side-effect-free `fgown` recheck), but the corrected experiment has NOT been re-run -
  caller-side exclusion therefore remains a hypothesis consistent with observations, not
  a proven elimination.

Single-trigger limitation: fixture windows being destroyed while (probably) inside the
shell's minimized/restore set correlates with wedge onsets across the day. It is a
correlation on a live desktop, not an isolated reproduction; a clean trigger experiment
needs an idle, isolated Windows session.

## Instruments (owned windows; no titles, paths or user content recorded)

`fixtures/fixture_app.cpp` stdin command channel (diagnostics only, never shipped; whole
line must exactly match a known command of at most 16 characters - prefix, unknown and
overlong input is rejected and counted, never executed):

| command | effect |
| --- | --- |
| `minimize` | the fixture minimizes its own window (observer self-test) |
| `census` | aggregate desktop census: ordinary top-level window counts (total/minimized), cloaked, topmost, no-activate, popup, `fgShell`, the fixture's own minimized flag |
| `fgown` | side-effect-free probe: is the fixture's own window foreground RIGHT NOW, plus the count of rejected commands so far |
| `wind` / `alt` | removed during Codex integration; rejected as unknown commands |
| `quit` | terminate the fixture |

Zcode's revision restricted the legacy injected-input commands, but Codex found that
keyup results were still unchecked and other held modifiers could interfere. Those unused
manual commands and all fixture `SendInput` code were removed instead of extending their
input state machine. No current fixture command injects keyboard input. Earlier Win+D/Alt
observations remain historical, with delivery/shared-session limitations; they are not
physical-input proof.

`tests/e2e.mjs` modes (revised): the mandated two-toggle check is unchanged - both
replies must be `desktopToggled` with exit 0; `LOLPING_DESKTOP_EFFECT_STRICT=1` makes a
missing both-ways window movement (one minimize and one restore) a **failure**, never a
skip; `LOLPING_DESKTOP_DIAG=1` adds non-input comparisons only (observer self-test,
censuses, PowerShell COM host, unique-path foreground-state fixture with `fgown`
rechecks). Disruptive runs belong in an agreed idle window; none were run in the revision
round while Codex's strict checks were in flight.

## Evidence chronology (primary output as recorded, 2026-10-26)

| time (approx) | observation |
| --- | --- |
| morning | native e2e: COM pair round trip observed (`minimized -> restored`); repeated green runs |
| afternoon run B | canary granted, COM pair no-effect; PowerShell pair no-effect; injected Win+D minimized once, second injection did not restore; permission later read denied after the desktop had been left minimized |
| probe 1 | baseline census `total=9 minimized=3` (residual minimized windows); COM toggles no-op; injected Win+D restored those 3; a second injection did nothing |
| probe 2 | all paths no-op in both directions |
| MinimizeAll probes | `MinimizeAll()` minimized (e.g. `0 -> 3`), `UndoMinimizeALL()` restored (`3 -> 0`) every time called |
| probe 3 | COM toggles alive (twice) while injected Win+D stayed dead - same minute |
| probe 4 | from the "shown" state left by probe 3, COM restore dead; fixture kills around minimized sets had occurred between probes |
| final diag runs | COM pair worked from the harness caller and from the fixture-foreground session (confounds as noted above); injected Win+D one-directional the same minute; 3/3 strict runs green; 101 unit + 33 e2e default green |

## Candidate-cause assessment (observation vs inference)

| candidate | assessment | basis | confound/unknown |
| --- | --- | --- | --- |
| fixture observer fault | not observed to contribute | self-test catches self-minimize + helper-restore; census agrees independently | observer polls state at ~20 ms; sub-20 ms flicker would be missed |
| slow asynchronous delivery | not observed to contribute | 10 s observation windows; censuses minutes later unchanged | none known |
| our COM usage (apartment/lifetime) | not observed to contribute | PowerShell hosts behave identically; our call succeeds when healthy | apartments/hosts not exhaustively varied |
| caller foreground/input eligibility | consistent with observations, NOT excluded | granted canary + no-effect; foreground-session pair worked | canary perturbs state; one-time event; shared exe path; corrected experiment not yet run |
| shell show-desktop state desync | best-supported explanation | divergence between COM toggle and injected Win+D; residual minimized windows while shell acts as if desktop shown; MinimizeAll/Undo unaffected | Explorer internals not inspected; single trigger not isolated; live shared desktop |

## Fix decision (and why `toggle_desktop.cpp` is unchanged)

Constraints: keep the protocol and `desktopToggled` semantics, no silent retries, no input
injection, no AttachThreadInput, no foreground-policy changes, no custom minimize-all, no
automatic global repair operations.

- `ToggleDesktop` reports success without an observed window effect in failing runs.
  The available evidence does not establish a safe helper-side correction or prove the
  internal point where the requested work is lost.
- Swapping to `MinimizeAll()`/`UndoMinimizeALL()` needs a direction decision. Both live
  signals have observed failure modes: `fgShell` (desktop window foreground) is also set
  when the user merely clicks the desktop with windows shown, and window counts are
  confounded by popup-class windows that resist minimize (6 of 11 on this machine) and by
  the user's own minimized windows. A wrong-direction toggle is a new user-visible failure
  mode. Under the tested conditions no swap was established to be safe.
- Candidate product directions for Codex's decision (all keep the wire protocol): a
  state-sampled MinimizeAll/UndoMinimizeALL pair with its failure modes documented; a
  user-visible "restore desktop" affordance (UndoMinimizeALL) rather than an automatic
  global repair; or accepting effect-uncertainty with the strict gate defining
  acceptance. Nothing here was auto-applied.

## Product-relevant observations for Codex

- Main's existing 3-second helper timeout is load-bearing: during diagnosis, three
  orphaned `desktop-helper.exe` processes were found alive with no reply after being
  spawned by a removed fixture experiment (`selftoggle`). Where they were hung is
  inferred (no output, process alive, never exited); no stack trace exists, so "inside
  the COM call" is inference, not a proven location. Keep the timeout; never await the
  helper unbounded.
- `desktopToggled` must never be treated as desktop-effect acceptance (the contract says
  so; strict mode enforces it in tests).
- The smoke failure shape (fixture restored to foreground, then first toggle no-effect)
  was reproduced natively with no Electron components; that observation stands on its own.

## Commands and results

Diagnosis round (before revision): `node native/desktop-helper/run.mjs test` exit 0 -
unit 101/0, e2e 33/0/0 with effect observed; `LOLPING_DESKTOP_EFFECT_STRICT=1` exit 0
three consecutive runs; `LOLPING_DESKTOP_DIAG=1` exit 0 with the divergence log captured
above. During the wedged periods the same predicate reported a visible skip in default
mode (the strict branch fails on the identical condition; strict was not running during
those earlier periods - its failure output was not captured live).

Revision round (this document): disruptive desktop runs deliberately NOT executed while
Codex's strict checks run. Executed instead:

| command | result |
| --- | --- |
| `node native/desktop-helper/run.mjs build` | exit 0, clean under `/W4 /WX` |
| `build\desktop_helper_tests.exe` | 101 passed, 0 failed |
| `node --check tests/e2e.mjs` | syntax OK |
| focused parser/guard checks (owned hidden window, not shown; no toggles/injection) | Zcode reported 7/7 on its earlier revision: exact census, prefix/40-byte rejection, rejected legacy injection commands, accounting and quit. This did not cover long lines split across reads or embedded NUL bytes. |

Strict and diag suites: **unrun in the revision round** by instruction; their previous
results stand as recorded above.

Desktop restoration note (observation, not proof of full arrangement): after the
disruptive comparisons the census showed `minimized=4`, matching the pre-experiment
baseline count, and `UndoMinimizeALL` had been issued via the shell. Only the aggregate
count was observed; per-window arrangement was not verified.

## Codex integration checkpoint

The first root run against the revised handoff failed after five focused checks: a
70-byte invalid line incremented the rejection counter twice (`rejected=5`, expected 4).
The `fgets`/`strlen` implementation split long physical lines and could treat a suffix as
a fresh command; embedded NUL bytes could also hide a suffix from string comparison.

The integrated reader retains at most 17 bytes (16 plus optional CR), drains the rest of
one physical line and rejects it once. Exact `std::string` comparisons reject embedded
NUL; EOF does not complete an unterminated command. The unused input commands were removed.
`tests/fixture_commands.mjs` exercises the real hidden fixture: exact census/foreground
probe, prefix/unknown/40-byte/70-byte/16-byte/17-byte rejection, NUL, a long-line quit
suffix, removed input commands, CRLF and clean quit. The corrected fixture passed all
15 checks after the real failing run. It never showed a window, toggled the desktop or
injected input. The standard native test entry now runs these checks before e2e.

Codex retained the strict effect predicate. The optional foreground comparison now uses
an atomically unique temporary copy, skips a falsely labeled foreground case when current
ownership is unconfirmed, samples before each request, and validates its cleanup path.
The corrected disruptive diagnostic comparisons remain unrun; code inspection and parser
checks do not establish desktop reliability. The earlier independent failures in
`p3-desktop-review.md` remain acceptance blockers. Production helper sources and Main are
unchanged. The module README keeps root's newer integration history.

## Remaining limits

- Wedge single trigger: correlational only; needs an idle isolated session.
- Caller-side exclusion: corrected experiment designed (unique-path copy + fgown
  rechecks) but not run.
- Whether the Electron flow hits the wedge during real gameplay is untested; acceptance
  there must use strict-mode semantics (reply without effect = failure).
- No physical-input, UAC, mixed-DPI or full-wheel acceptance is claimed anywhere above.
