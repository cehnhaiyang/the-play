---
name: player-media-transport
description: Applies to this project only (the-play). How local files reach the renderer's `<video>`/`<img>` in this Electron app — the `tpf:` protocol, why `file://` is unusable from the dev page origin, the mandatory Range semantics, and the CSP/restart consequences. Read before touching `app/main/localprotocol.js`, `shared/core/media.ts` (`toPlayableUrl`), or anything that assigns a media `src`.
whenToUse: A local file does not play, plays only in the packaged build, seeks wrongly, or you are about to change how media URLs are produced or assigned.
---

# Local media transport (`tpf:`)

## The rule

**Never hand a local file to the renderer as `file://`.** Every local path must go through
`toPlayableUrl()` from `shared/core/media.ts`, which rewrites `file://…` into
`tpf://local/<encodeURIComponent(absolute path, forward slashes)>`; everything else
(`http(s)`, `blob:`, `data:`) passes through untouched.

Apply it at the moment of assignment, not at storage time:

- `app/hooks/usePlay.ts` — `video.src = toPlayableUrl(file.url);`
- `app/components/PlayPanel.tsx` — `<img src={toPlayableUrl(currentFile.url)} …>`

Stored URLs stay `file://` (that is what `pathToFileURL` in `acgmhoService.js` /
`ehentaiService.js` writes into the playlist), so the rewrite is what makes them playable.

## Why `file://` fails

From the dev page origin `http://localhost:5173` (which is what `.bat` → menu 3 serves),
Blink rejects a `file://` subresource. Measured on Electron 44.4.5:

```
event order: emptied → play → waiting → loadstart → error
error.code       = 4
error.message    = "Media load rejected by URL safety check"
networkState     = 3 (NO_SOURCE)
currentTime      = 0 forever
```

The element never receives a byte, so the UI shows an endless spinner while the file itself is
perfectly fine. The packaged build loads the page from `file://`, where the same URL works — that
asymmetry is why this looks like "broken files" or "bad cache" instead of a URL-policy problem.
`webSecurity: false` does **not** bypass this check.

## Implementation map

| Piece | File |
|---|---|
| scheme registration + handler | `app/main/localprotocol.js` (`registerLocalFileScheme`, `registerLocalFileProtocol`) |
| scheme constant + URL mapping | `shared/core/media.ts` (`LOCAL_FILE_SCHEME = 'tpf:'`, `toPlayableUrl`) |
| CSP allowances | `app/index.html` (`media-src`, `img-src`, `connect-src` must each list `tpf:`) |
| regression guard | `test/localplayback.test.js` |

Ordering matters: `registerLocalFileScheme()` must run **before** `app.whenReady()`
(privileged scheme), `registerLocalFileProtocol()` **after** it. `main.js` does both.

Privileges are all required: `standard: true` (host/path parsing), `secure: true`,
`supportFetchAPI: true`, `stream: true` (media can stream instead of waiting for a full body),
`bypassCSP: true`.

## Range is not optional

A media element seeks by requesting a byte range and mapping time→offset from the reply. The
handler must answer `206` with `Content-Range: bytes <start>-<end>/<total>` and a matching
`Content-Length`; a `416` must carry `Content-Range: bytes */<total>` or the element loses the
total length and the progress bar/seek break. Returning `200` for everything makes every seek
refetch from the start.

**Do not replace the handler with `net.fetch(pathToFileURL(file))`.** Measured: it ignores the
`Range` header — status `200`, no `content-range`, no `content-length`. It was tried and reverted.

Media URLs are open-ended by design (`bytes=<start>-`); Chromium stops reading when it has enough,
so the byte count per seek stays small (≈2MB per seek on a 271MB file). That is normal, not a leak.

## Restart matrix

`localprotocol.js`, `main.js`, `preload.js` and `shared/meta/**` are main-process code:
**restart the app** (`app/main/main.js` changes never hot-reload). Renderer changes
(`usePlay.ts`, `PlayPanel.tsx`) need `js build` (or a vite reload) plus a page refresh. A CSP
edit in `app/index.html` needs both a rebuild and a restart of the packaged path.

## Failure this prevents

`file://` rejections are silent at the app level (no exception, no console error you would read
as fatal) and only surface as an eternally buffering player, which invites wrong conclusions about
the file, the codec or the download. Routing every local URL through `tpf:` removes the entire
class.
