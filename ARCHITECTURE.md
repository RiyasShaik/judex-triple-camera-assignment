# Architecture Notes

## Overview

The system has two parts:

1. **Backend** (`tri_stream_server.py`) — a Python server that simulates 3 live HLS camera streams and provides REST APIs for sync/events data
2. **Frontend** (React + Vite) — a player that connects to all 3 streams simultaneously and provides the review UI

## How the streams work

Each camera gets its own thread that loops through the pre-recorded `.ts` segments. The thread maintains a sliding window of 30 segments and writes a `live.m3u8` playlist file. Since we never write `#EXT-X-ENDLIST`, hls.js treats it as a perpetual live stream.

The segments are symlinked (not copied) from the original directories, so startup is instant and uses zero extra disk space.

The tricky part was loop restarts — if the media sequence resets, hls.js gets confused and disconnects. So I keep `global_seq` incrementing monotonically across loops. That way hls.js sees a continuous stream even though the content wraps around.

## Cross-camera sync

The assignment provides a CSV file (`hls_sync_1645_triple.csv`) with ~10,797 rows mapping frame indices across all three cameras. When you switch cameras, the frontend calls `/sync_time` with the current playback time, and the server:

1. Finds which segment that time falls in
2. Gets the midframe of that segment
3. Binary searches the sync table for the nearest matching row
4. Reads off the corresponding frames for all 3 cameras
5. Converts those frame numbers to timestamps using the frame index

I use `bisect` for the lookups since linear scanning 10k rows on every camera switch would be slow.

## Review mode lifecycle

```
LIVE → enter review → REVIEW → go live → LIVE
```

When entering review mode:
- `stopLoad()` + `destroy()` all 3 hls instances (stops downloads immediately)
- Snapshot the rolling byte buffers (safe since hls.js is dead)
- For each camera: create blob URLs from the raw bytes, build an m3u8 pointing to those blobs, create a new hls.js instance playing from the blob m3u8
- Result: fully offline playback from memory

When going back to live:
- Destroy the review hls.js instances
- `URL.revokeObjectURL()` on everything to free memory
- Clear the rolling buffers
- Create 3 fresh live instances

Camera switching in review mode uses the `originalStart` metadata we stored with each segment to map positions between cameras, so no server calls are needed.

## Why 3 simultaneous video elements

The assignment requires near-instant camera switching. If we destroyed and recreated hls.js instances on every switch, there'd be a noticeable delay while it connects, downloads the playlist, and buffers the first segment.

Instead, we keep all 3 `<video>` elements stacked with `position: absolute` and toggle `opacity`. The hidden videos are still playing (muted) and buffering, so when you switch, the data is already there.

## Event system

Shot events come from `flight_shots.csv`. The server parses it at startup and pre-computes:
- Playback timestamps for each camera (via frame-to-time conversion)
- Bounce clip filenames (with fuzzy matching if the exact name doesn't exist)
- Whether clips actually exist on disk for each camera

The frontend shows these as yellow dots on the seekbar (inspired by Hotstar's key moments feature). Clicking a dot opens the event panel with 3 side-by-side video players.

## Performance numbers

- Server startup: < 1 second
- Camera switch latency: ~80ms
- Sync API response: < 1ms (binary search)
- Frontend build: ~1.3 seconds
- Review mode entry: near-instant (just blob creation + hls init)
