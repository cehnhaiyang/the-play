---
name: app-run-and-verify
description: Applies to this project only (the-play). How this app is actually launched (double-click `.bat`, menu 3 → vite 5173 + Electron), the kill-then-restart discipline, the DSH task commands and test-suite registration, the constraints the test harness imposes on `app/main/*.js` and `shared/core`, and the recipe for a bounded Electron probe. Read before starting/restarting the app, adding a test, or claiming a fix is verified.
whenToUse: You need the app running, you changed main-process code, you added a test suite, or you are about to measure behaviour in the running app.
---

# Running and verifying this app

## How the user runs it — reproduce it the same way

Double-click `.bat` → menu → `3` (the "开发环境" / dev-environment entry) → `npm run electron:dev` → `vite` on
`http://localhost:5173` + `electron .`, with the console window left open. `.bat` reads `.ps1` as
UTF-8 via `[System.IO.File]::ReadAllText` and executes it with `Scriptblock::Create`; `.ps1` must
keep its UTF-8 BOM (`test/scripts.test.js` fails otherwise).

Consequences:

- The dev page origin is `http://localhost:5173`, not `file://`. Behaviour differs between dev and
  packaged — never generalise a dev-only result.
- **Do not hand-write a launcher `.bat`.** cmd parses batch files as CP936; a UTF-8 file with
  Chinese text or `set VAR=` lines produced `'REMOTE_DEBUG_PORT' 不是内部或外部命令` /
  `拒绝访问` and a half-broken window. If a launcher is unavoidable, write it ASCII-only with
  `chcp 65001` first, or drive `electron .` directly.
- **Kill before restart**: check the owner of port `5173`/`9333` and `electron.exe` processes whose
  path starts with `D:\the-play`, kill them, then start. Launching a second instance over a live
  one produced two half-working apps and a false "cannot reproduce".
- **Vite 8 binds `localhost` (may resolve to `::1`).** Probing `127.0.0.1:5173` gives a false
  negative — probe `localhost` and `::1` as well before declaring the server down.

## Task commands (DSH tools, the only way to shell out)

| Call | Runs |
|---|---|
| `js check` | `tsc --noEmit` |
| `js test` | `npm test` in `test/` → `node test/index.js` |
| `js build` | `vite build && npm run ext:build` (refresh `dist/` after renderer changes) |
| `js node <paths>` | runs `.js` scripts; directories contribute every `.js` beneath them |

`test/index.js` compiles `shared/**`, several `app/services/**` files and some `extension/src/**`
into `test/build/`, then runs each suite. **A new suite must be added to `test/index.js` twice**: the
`require(...).run()` block and the final `if (!...)` conjunction, or it silently never runs.

## Harness constraints that bite

- **`test/mainstatic.test.js`** static-scans `app/main/*.js` for identifiers that are called but
  never declared. Node/Electron globals used there must be listed in its `GLOBALS` set —
  `Response` and `Request` had to be added when `protocol.handle` started returning responses.
- **`test/extsniffer.test.js`** evaluates `shared/core` in a DOM-less, electronAPI-less sandbox, so
  nothing in `shared/core` may touch `document`, `localStorage` or `getElectronAPI` **at evaluation
  time**. Path/DOM work belongs in the renderer hook, not in `shared/core`.
- Test files read source text with regexes, so an assertion can match a **comment**. A comment
  mentioning `MEDIA_EXTENSIONS` broke a "the main process must not hold an extension table" check.
  Keep such assertions anchored on code shapes (`NAME =`, `name(`), not on bare words.
- Bridge contract: every `ipcMain.handle('x')` must be classified in `shared/meta/bridge.ts`
  (`BRIDGE_ENDPOINTS`, `route` + `reason`), or `test/bridge.test.js` fails. Removing a handler
  requires removing its table entry too.

## Bounded Electron probe recipe

When behaviour can only be observed in the real app:

1. Write one file under `tmp/` that re-spawns itself under Electron:
   `if (process.env.PROBE_CHILD !== '1') { spawn(require('electron'), [__filename], …) }`.
2. Give it its own profile and a debug port: `--user-data-dir=tmp/<name>` plus
   `--remote-debugging-port=<port>`; attach over CDP with `http://127.0.0.1:<port>/json/list`.
3. Pick the **main** page (`url === 'http://localhost:5173/'`); the orb windows
   (`/orb/sniff.html`, `/orb/agent.html`) match looser patterns and will be chosen by mistake.
4. **Every probe gets a hard watchdog** (`setTimeout(..., 55000)` → kill self and exit). The user
   has been blocked by probes without a timeout; nothing may run "until it finishes".
5. Drive the real UI (click the tab, click the row, click `.tp-seek-btn`) rather than calling
   internals; `DataTransfer` + `dispatchEvent('change')` works for `<input type=file>` only when the
   real import path still exists.
6. Delete `tmp/` scratch afterwards — stray binaries there break `tsc --noEmit`, and a leftover
   `.bat`/probe is not part of the project.

## Change discipline the user enforces

- Main-process or preload change ⇒ app restart; renderer change ⇒ `js build` (or vite reload) and a
  page refresh. Say which is needed instead of assuming a hot reload.
- **No debug switches left in the product**: an env-gated `remote-debugging-port` hook was added for
  diagnosis and had to be removed afterwards.
- **No migration code for stored data.** Fix the reader/writer; do not write "convert old
  records" passes.
- **One implementation per pipeline.** Two copies of a download/scan/URL-mapping path is a defect
  even when both work.
- Comments state the measured fact and the reason ("evidence + why"), never a restatement of the
  code; regression tests assert invariants (behaviour, contracts), not syntax.
- `resource/` is user data: never delete, move or reorganise it.
- Report numbers, not prose. "Verified" requires a command or a measurement; otherwise say "checked
  by reading", explicitly.
