---
name: media-library-directory
description: Applies to this project only (the-play). The playback list is a mirror of one directory (`settings.resourceRoot`, default `<appPath>/resource`) — where the scanner lives, what it filters, how directories become gallery groups, the `library-scan` / `library-set-root` IPC contract and the bridge-table requirement. Read before touching the playlist source, adding files to the list, or changing the library root.
whenToUse: Work on the playlist, the sidebar tree, the refresh button, the library path setting, or any feature that would "add files" to the player.
---

# Playlist = the library directory

## There is no import

File/folder pickers, drag-import, `.gallery` unpacking on import and the "添加媒体 / 目录 / 打包"
(add media / directory / pack) buttons were removed on purpose. The playlist is rebuilt from disk; "refresh" means "scan again".
File drag is still intercepted (`dragover`/`drop` `preventDefault`) — not to import, but so the
window is not navigated to the dropped file.

Adding a new "add to playlist" entry point re-creates the second source of truth this design
removed: entries that exist in the list but not on disk (or vice versa), and a persisted list that
disagrees with the folder.

## Root resolution

`settings.js` holds `resourceRoot` (default `''`). Empty means "compute it":
`gallery.resourceRoot()` → `<app.getAppPath()>/resource` when unpackaged,
`<userData>/resource` when packaged. Only absolute paths are accepted
(`path.isAbsolute`, error: `请填写绝对路径，例如 D:\the-play\resource`); the value is `path.normalize`d.
Relative paths are rejected because the main process's cwd differs between `.bat` and an installed
build.

## Scanner (`app/main/library.js`)

- Exports exactly `scanCurrent()` and `setRoot(input)`. `setRoot` saves and scans in one call —
  splitting it lets the user edit the field between the two and scan a different path.
- `scan()` returns `{ root, exists, entries: [{ url, relative }], truncated }`.
  `exists: false` is a normal outcome (a directory that does not exist yet), not an error.
- Uses `fs.readdirSync(dir, { withFileTypes: true })`; **no per-file `statSync`** — `Dirent.isFile()`
  already answers it, and 593 files made 593 pointless syscalls.
- Skips directories only: `SKIP_DIRS` (`node_modules`, `.git`, `.svn`, `.hg`, `$RECYCLE.BIN`,
  `System Volume Information`) and any dot-directory. File-level filtering belongs to the pure layer.
- Caps: `MAX_ENTRIES = 20000`, `MAX_DEPTH = 12`. A mis-pointed root (`C:\`) must not freeze the
  renderer.
- Contains **no media-extension table**. The main process is plain CJS and cannot import the TS
  table; a copy would drift. `test/library.test.js` asserts the scanner contains no
  `getMediaType` / `MEDIA_EXTENSIONS` / `'mp4'` literal.

## Decision layer (`shared/core/library.ts`)

`buildLibraryFiles(entries)` is pure (no DOM, no fs) so Node tests can call it directly.

- Filters via `getMediaType` (drops `'other'`) and ignores: dot-files, `.part/.tmp/.download/
  .crdownload/.!ut`, `manifest.json` (gallery bookkeeping), `*.gallery` (grouping marker),
  `*.aibook` (container with no path-based open path — listing it would be a dead row).
- Sorts by `localeCompare(..., { numeric: true })` so `10.jpg` follows `9.jpg`.
- **Directory become a gallery group** when it holds ≥2 media files whose stems are all digits:
  `groupId = lib:<relative dir>`, `groupName` = last path segment, `groupType: 'gallery'`,
  `page = Number(stem)`. Any non-numeric stem in the directory disables grouping for the whole
  directory (a group whose page numbers do not match the files is worse than a plain folder).
- Otherwise the entry carries `folder: <relative dir>` and the sidebar renders it as a folder tree.

## IPC contract

`ipcMain.handle('library-scan')` and `ipcMain.handle('library-set-root')`, registered in
`main.js`'s gallery-handler setup; preload exposes `library.scan()` / `library.setRoot(value)`;
types are `LibrarySnapshot` / `LibraryFileEntry` / `ElectronLibraryAPI` in `shared/meta/interface.ts`.

**Every `ipcMain.handle(name)` must exist in `shared/meta/bridge.ts` `BRIDGE_ENDPOINTS`** with a
`route` and a `reason` — `test/bridge.test.js` scans the source and fails otherwise. Both library
endpoints are `route: 'app'` (fs lives in the main process).

## Renderer side (`usePlay.ts`)

- `applyLibrarySnapshot` replaces only the entries whose URL matches `^file://` (the disk-derived
  ones) and keeps online entries (URL / ACG pushes / AI-book `blob:` pages) after them, re-anchoring
  the current position by URL so a refresh does not jump elsewhere.
- Auto-scan on mount — the user must not have to press refresh to see their own library.
- Playlist persistence (`theplay.playlist.v1`, raw key, no prefix) stores **only `https?://`
  entries**. Disk entries are rebuilt by the scan; persisting them would create a stale mirror.

## Failure this prevents

Two sources of truth: a list that keeps deleted files, misses new ones, and disagrees with the
folder after every restart. Every rule above exists to keep exactly one authority — the directory.
