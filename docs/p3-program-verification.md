# Program boundary verification

Codex, 2026-10-26. The former zcode program-test task was paused in favor of the
desktop-effect investigation. Codex added these tests in its own P3 worktree without
editing zcode's native files or running competing desktop experiments.

`tests/main/quickActionProgram.test.ts` adds 16 Windows-only cases using real owned
temporary files and a directory junction. They cover unsupported path forms, a copied
real executable with Unicode/spaces/apostrophe/ampersand, missing files, a regular file
used as a directory, an `.exe` directory, an ordinary text file, canonical junction
resolution, removal after selection and OS launch rejection for a missing executable.
Cleanup resolves and checks the exact owned temporary directory before removal.

Commands run:

- Targeted program/executor/IPC Vitest: 35 passed in 3 files, exit 0.
- `npm run typecheck`: exit 0.
- Full `npm test -- --reporter=dot`: 1414 passed in 87 files, exit 0.

No program was successfully launched by this new suite, no browser or desktop action
was executed, and no user configuration was read. The launch case verifies error
propagation from real OS process creation failure. Successful launches, foreground
behavior, tray compatibility, UAC and physical input remain separate acceptance items.
Non-Windows systems explicitly skip these Windows-specific path/filesystem cases.
This adds coverage to existing production behavior; no production source was changed.
