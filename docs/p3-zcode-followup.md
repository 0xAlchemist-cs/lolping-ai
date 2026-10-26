# zcode follow-up: native acceptance findings

Codex reran `node native/desktop-helper/run.mjs test` on 2026-10-26: 92 unit checks and 27 real-executable/window tests passed, zero failed/skipped. The original hardware/full-wheel/UAC/mixed-DPI limitations remain. Codex also reproduced the Unicode scalar issue below. Native completion is pending this focused follow-up.

Continue in `D:/lolping/lolPing-p3-desktop` on `feat/p3a-desktop-helper`. Read `AGENTS.md` and `docs/p3-desktop-helper-contract.md`; the wire protocol and file ownership are unchanged. This follow-up is deliberately confined to `native/desktop-helper/**`.

## 1. Reject UTF-8 above U+10FFFF

`copyRawUtf8` validates shortest forms and surrogates but never rejects a decoded scalar greater than `0x10FFFF`. For an activate request with a drive-rooted exe path containing bytes `F4 90 80 80` (U+110000), the current executable returns `invalidPath`: malformed UTF-8 passed the protocol parser and was rejected only by Windows conversion.

The required result is `{"type":"result","status":"error","code":"invalidRequest"}` with exit 1. Validate the Unicode scalar upper bound inside the protocol layer before copying raw bytes.

Add RED/GREEN tests for out-of-range four-byte sequences (including F4 90 80 80 and F5/F7 prefixes), while retaining valid U+10000 and U+10FFFF boundary behavior. Exercise the actual executable with Buffer input, not a JS string that normalizes/replaces invalid bytes.

## 2. Compare Unicode Windows paths correctly

The current ASCII-only case folding can miss an already running application whose non-ASCII path differs only in case. Preserve separator normalization but use a documented ordinal Windows case-insensitive comparison (`CompareStringOrdinal` or equivalent) for complete UTF-16 paths. Do not use locale-dependent titles, basenames or guessed installation paths.

Add a controlled test using a copied fixture executable in a temporary Unicode path and a case variant. Clean up only the fixture's own temporary files/processes. Keep spaces, apostrophes and ampersands valid. Record the actual result, and update the former ASCII-only limitation in README.

## 3. Revalidate the window identity before activation

The selected HWND can disappear or be recycled between enumeration and the bounded activation loop. Keep the selected process identity as well as HWND, and verify the HWND still belongs to that same process and expected complete exe path before requesting restore and before every foreground attempt. Stop with `activationDenied` if the selected window disappears, changes identity or becomes ineligible; never activate a recycled unrelated HWND and never return `launchRequired` after a matching window was already selected.

Retain the bounded/nonblocking behavior and do not add input injection, AttachThreadInput, elevation or UI-thread blocking calls. Add focused controlled tests for window destruction/identity mismatch where reproducible; distinguish deterministic guard tests from OS race stress evidence.

## Verification and coordination

- Rerun the full native build/test and record exact new counts and exit status.
- Run the original scenarios, including two desktop toggles, to detect regressions.
- Update native README with findings, fixes, evidence and remaining manual limitations.
- Do not modify any existing input helper, TypeScript, settings, IPC, packaging or gate configuration.
- Do not retry bypass flags or weaken Mimosa. Codex owns final commits, integration and PR; leaving your corrected files and explicit staged/unstaged state is sufficient.
- Observe Codex via `git log -5 --oneline feat/p3a-windows-actions`, `git show`, and the other worktree's `git status`. The new brief is on Codex's branch; inspect it there without merging/rebasing your worktree.
- Do not merge, cherry-pick, reset or edit the other worktree. Report when these three findings are addressed, with changed paths, test commands/results and any unresolved issue.
