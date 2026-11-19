---
name: playback-seek-performance
description: Applies to this project only (the-play). Measured cost budget for seeking local video in this player, the two renderer-side defects that actually caused multi-second stalls (auto-opened DevTools, per-event re-render of the whole panel), the buffering-overlay delay, and the hypotheses already disproved by experiment. Read before changing playback state handling, the progress bar, or investigating "local video buffers when I seek".
whenToUse: A seek/fast-forward stutters, the "正在缓冲…" overlay appears too eagerly, or you are about to re-investigate why local playback feels slow.
---

# Seek performance (local video)

## Do not re-investigate these — they were measured and ruled out

Electron 44.4.5, this app, real files from `resource/`:

| Hypothesis | Measurement | Verdict |
|---|---|---|
| Slow transport | `tpf:` seek end-to-end 80–125ms; rapid seeks (60/120ms apart) ≤125ms; loopback HTTP server served the same file at the same speed | not the cause |
| Range handling broken | reads are open-ended (`bytes=<start>-`), ~2MB consumed per seek, ≤1 stream left open after 10 seeks | not the cause |
| Keyframe/GOP decode | controlled A/B on a 10.4s-GOP file: seek 0.2s after an I-frame 5–17ms, seek 9.4s past one 116–184ms | 130ms scale, not seconds |
| Some file is pathological | all 12 library videos, 3 far seeks each: worst 242ms | not the cause |
| Main-process contention | busy-looping the main JS thread 200ms out of every 300ms: 50ms vs 59ms idle | no effect |
| Disk contention | child process writing 400MB while seeking: 62ms vs 59ms | no effect |
| Offscreen/invisible element suspension | 12 invisibility forms (offscreen, `display:none`, `visibility:hidden`, `opacity:0`, covered, 2×2, 0×0, `clip-path`, `content-visibility`) all played and advanced `currentTime` | false premise |

`net.fetch(pathToFileURL(...))` cannot replace the protocol handler — it ignores `Range`
(status 200, no `content-range`).

## What actually caused it

Renderer main-thread cost, two sources:

1. **DevTools auto-opened in dev** (`createWindow` called `openDevTools()` unconditionally). It is
   a continuously painting window competing with the video for composition. Removed — open it by
   hand (F12) when debugging.
2. **Playback progress re-rendered the whole panel at event rate.** `timeupdate` (4–10Hz) called
   `setState`, and a second channel (`progress` listener bumping a `bufferedVersion` state) did the
   same during buffering. Each render rebuilt the entire PlayPanel tree.

Measured before → after: click→`seeking` 72–113ms → **13ms avg / 21ms max**; click→picture
320–400ms → **75ms avg / 168ms max** over 6 consecutive fast-forwards, no spinner flash.

## Rules that keep it fixed

- **One progress channel.** `app/hooks/usePlay.ts` `onTimeUpdate` is throttled to
  `PROGRESS_UPDATE_INTERVAL_MS = 250` and skips when the position moved less than
  `PROGRESS_UPDATE_MIN_DELTA = 0.05`. Do not add a second state that events bump — that is exactly
  the removed `bufferedVersion`. `PlayPanel` reads `video.buffered` during render instead.
- `seek()` must write the new position to state immediately; throttling applies only to
  `timeupdate`, never to an explicit seek.
- **Buffering overlay is delayed**, not immediate: `BUFFER_INDICATOR_DELAY_MS = 250`. `waiting` only
  starts a timer; `playing`/`canplay`/`seeked`/`error` and the effect cleanup must all clear it
  (otherwise the spinner hangs, which is a worse bug than a missing spinner). Rationale: local
  seek/load waits are 80–350ms, and flashing a full-screen overlay for those reads as a fault,
  which makes a working player look broken.
- Never auto-open DevTools again; a continuously painted window is a real cost on a media app.

## Useful tool commands

Keyframe intervals (GOP) of a file, without decoding everything:

```
ffmpeg -v info -skip_frame nokey -i <file> -an -vf showinfo -vsync 0 -f null -
# parse "pts_time:<t>" from stderr; gaps between consecutive values are the GOPs
```

Library files measured with this: 3.0s (271MB/720p), 5.2s, 10.4s. Dense keyframes cannot be added
without re-encoding — `-g` / `-force_key_frames` are encoder options and are ignored under
`-c copy`. Measured re-encode speed on this machine with
`-c:v libx264 -crf 18 -preset veryfast -g 48`: 1280×720 → 19.3x, 852×480 → 13.6x (a 36-minute 720p
file ≈ 2 minutes). Audio/subtitles can stay `-c:a copy` / `-c:s copy`.

## Reporting rule the user enforces

State the measured numbers (before/after, per-condition table), name the hypotheses that were
disproved, and retract an earlier claim explicitly when new data contradicts it. A mechanism
asserted without a measurement has already cost this project several wrong fixes.
