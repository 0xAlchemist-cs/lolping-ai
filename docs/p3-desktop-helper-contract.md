# P3 desktop helper collaboration contract

Status: interface agreed; native implementation assigned to zcode. No Windows acceptance result is implied.

## Workspace and ownership

- Reviewed product baseline: `34f0e070500fbbbabfd24ba75b8c6008ce13f0e6`.
- Codex integration branch: `feat/p3a-windows-actions`, worktree `D:/lolping/lolPing-p3`.
- zcode native branch: `feat/p3a-desktop-helper`, worktree `D:/lolping/lolPing-p3-desktop`.
- Both worktrees share the local Git repository rooted at `D:/lolping/lolPing-main`.
- zcode owns `native/desktop-helper/**` only, including its local build ignore, runner, tests and README.
- Codex owns TypeScript, renderer, preload, settings, i18n, packaging, CI and top-level documentation.
- Do not edit the other worktree or another agent's files. Do not change the existing input helper.
- Each agent commits only its own explicit paths. Do not use `git add .`, reset, clean, force push, merge, rebase or delete another branch/worktree.
- No pushes or PRs are required for this handoff. Codex reviews and integrates native commits.

## Observing progress through local Git

No remote fetch is needed to see local branch references. Use:

```powershell
git worktree list
git log -5 --oneline feat/p3a-windows-actions
git log -5 --oneline feat/p3a-desktop-helper
git diff --stat 34f0e070500fbbbabfd24ba75b8c6008ce13f0e6...feat/p3a-desktop-helper
git -C 'D:/lolping/lolPing-p3' status --short --branch
git -C 'D:/lolping/lolPing-p3-desktop' status --short --branch
```

`git status` describes work in progress, not verified completion. A local commit and its documented test evidence are the integration checkpoint. Keep a short native progress/verification section in `native/desktop-helper/README.md`. Do not cherry-pick or merge Codex commits into the native branch while working; inspect them with `git show` instead.

## Native executable and transport

Build `native/desktop-helper/build/desktop-helper.exe` using the existing Visual Studio C++20 toolchain, with no new third-party dependency.

Entry points:

```powershell
node native/desktop-helper/run.mjs build
node native/desktop-helper/run.mjs test
```

`build/` must be ignored inside the owned directory. On non-Windows platforms explicitly report unsupported/skipped; do not claim Windows tests passed.

The helper is a one-shot console child. Electron starts it hidden with piped stdio, writes exactly one flat JSON object followed by LF, closes stdin, reads one JSON result line and waits for exit. It must not stay resident, listen on a socket, install hooks, launch a target executable or show a console window. Diagnostics go to stderr and contain no window titles or executable paths. Maximum request size is 64 KiB, maximum response size is 4 KiB. Reject nested JSON, trailing garbage, malformed types, invalid commands and truncated requests.

Requests:

```json
{"type":"activate","exePath":"C:\\Program Files\\Example\\Example.exe"}
{"type":"toggleDesktop"}
```

Successful/expected results (exit code 0):

```json
{"type":"result","status":"activated"}
{"type":"result","status":"launchRequired"}
{"type":"result","status":"activationDenied"}
{"type":"result","status":"desktopToggled"}
```

Errors (exit code 1):

```json
{"type":"result","status":"error","code":"invalidRequest"}
{"type":"result","status":"error","code":"invalidPath"}
{"type":"result","status":"error","code":"osError","win32":5}
```

`win32` is an optional nonnegative integer. No free-form error text is part of the wire contract. Unexpected internal errors also produce `osError` when possible. Electron owns the outer timeout and process cleanup; native calls must avoid unbounded waits on another application's UI thread.

## activate behavior

1. Validate a local absolute `.exe` path. Reject UNC, device namespaces, relative paths, embedded NUL/control characters, ADS, command text and parameters. Never use a shell or expand command strings.
2. Match ordinary top-level windows by their owning process's complete executable path. Do not match by title, basename, guessed installation path or arbitrary process name.
3. Consider visible/minimized ordinary application windows; exclude tool windows, owned transient windows, no-activate windows, cloaked windows and unrelated sessions. Follow enumeration Z order and select the first eligible exact-path match.
4. If minimized, request restore without blocking on a hung UI thread. Request foreground activation through documented Windows APIs. Return `activated` only when foreground activation succeeds; return `activationDenied` if a matching window cannot be activated. A taskbar attention request is allowed as a fallback, but it is not success.
5. If no eligible window is found, return `launchRequired`. This includes an application running only in the tray. Electron then decides whether to start the already approved executable with zero user arguments.
6. Do not launch the target from this module, inject input, simulate Alt/Win keys, attach to the input thread, elevate lolPing, modify the registry or bypass foreground restrictions.

## toggleDesktop behavior

Use the documented Windows Shell desktop toggle (for example `IShellDispatch4::ToggleDesktop` through COM), not PowerShell, CMD, a script, synthetic Win+D or custom snapshots/minimization of all windows. Balance COM/resource ownership. Report HRESULT failures as `osError`; `desktopToggled` means the system accepted the toggle request, not that a physical end-to-end gesture was verified.

## Tests and evidence

- Test malformed input, invalid paths, size bounds and expected result serialization through the actual executable.
- Provide a controlled native GUI fixture for normal, minimized, multiple-window and hidden/tray-like cases. Test matching and restoration against actual Windows windows where possible; never automate unrelated user applications or kill unrelated processes.
- Exercise two desktop toggles and document what was actually observed. Codex owns the later real lolPing-wheel integration proof.
- No changes to `native/hook-helper/**`, no injected input into a game, no paid AI requests, dependency installation, version bump or release.
- Record every verification command, exit status, passed/failed/skipped scenarios and remaining manual checks. Mock or synthetic tests must be labeled accurately; they do not prove hardware mouse, UAC, all DPI settings or full lolPing desktop restoration.

If the agreed protocol cannot express a necessary outcome, document the proposed change in the native README and report it before changing the contract. Do not silently change the protocol.
