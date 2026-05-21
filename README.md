# Triple-Camera Live Review System

A synchronized multi-camera streaming app built for real-time sports analysis. Three camera streams play simultaneously with instant switching, event-based replay, and bounce clip inspection.

## What it does

- Streams 3 cameras (SOURCE, SINK, HQ) as live HLS feeds
- Switch between cameras instantly (no rebuffering)
- Event markers on the timeline show detected bounce shots
- Click any marker to inspect the bounce from all 3 angles
- Review mode lets you rewatch buffered footage with zero network traffic

## How to run

### Backend

```bash
cd streaming-move-main
pip install -r ../requirements.txt
python3 tri_stream_server.py --speed 4.0
```

This starts:
- FastAPI on `http://localhost:8080` (REST API)
- SOURCE stream on `http://localhost:8081/live.m3u8`
- SINK stream on `http://localhost:8082/live.m3u8`
- HQ stream on `http://localhost:8083/live.m3u8`

Use `--speed 4.0` to run 4x faster (good for demos).

### Frontend

```bash
cd streaming-move-main/player
npm install
npm run dev
```

Open `http://localhost:3000` in your browser.

## Architecture

The backend (`tri_stream_server.py`) does two things:
1. **Simulates live HLS streams** - runs 3 daemon threads that loop through pre-recorded .ts segments, writing a sliding-window playlist file (`live.m3u8`) for each camera
2. **Serves data via REST API** - provides cross-camera sync mapping, shot events, and bounce clip files

The frontend is a React + Vite app with hls.js for HLS playback. The key insight is that all 3 cameras are connected and buffering simultaneously — switching cameras just changes which `<video>` element is visible and seeks to the synced timestamp. No reconnection needed.

### Camera switching

When you switch cameras, the frontend calls `/sync_time` with the current playback time. The server uses the triple-sync CSV (which maps frames across cameras) to figure out the equivalent timestamp on the target camera, and the frontend seeks to that time.

For the sync lookup, I pre-build sorted arrays from the CSV and use `bisect` for binary search since the table has ~10k rows and a linear scan would be too slow for every switch.

### Review mode

When you enter review mode:
1. All 3 live hls.js instances are destroyed (no more network requests)
2. The raw segment bytes we've been capturing from `FRAG_LOADED` events are turned into blob URLs
3. A new m3u8 playlist is built pointing to those blob URLs
4. New hls.js instances play from the blobs (completely offline)

Going back to live revokes all the blob URLs and restarts fresh live connections.

## API endpoints

| Endpoint | What it does |
|---|---|
| `GET /cameras` | Returns HLS URLs for all 3 cameras |
| `GET /sync?from_camera=source&from_seg=5` | Maps a segment position across cameras |
| `GET /sync_time?from_camera=source&from_time=44.5` | Same but takes a time instead of segment index |
| `GET /events` | All shot events with timestamps and clip filenames |
| `GET /events/{shot_id}` | Single event by ID |
| `GET /status` | Currently streamed segment per camera |
| `GET /frame_to_time/{camera}/{frame}` | Frame number to timestamp conversion |
| `GET /health` | Health check |
| `/clips/{cam}/{filename}` | Static bounce clip files |

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play/Pause |
| `←` / `→` | Previous/Next event |
| `1` / `2` / `3` | Switch to SOURCE/SINK/HQ |
| `R` | Toggle review mode |
| `Escape` | Close event panel |

## Data files used

- `sync_reports/ts_segments_{source,sink,hq}/1645/` — raw .ts segment files
- `test_work/cv_output/reader/{cam}/hls_segment_frame_index.csv` — frame-to-segment mapping
- `sync_reports/segments_1645/sync/hls_sync_1645_triple.csv` — cross-camera sync table (~10k rows)
- `test_work/cv_output/correlation/flight_shots.csv` — 139 shot events
- `bounce_clips_share/{source,sink,hq}/` — pre-rendered bounce clip MP4s (~89 clips per camera)

## Project structure

```
streaming-move-main/
├── main.py                   # original single-camera server (untouched)
├── tri_stream_server.py      # triple-camera backend
└── player/
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── main.jsx
        ├── index.css
        ├── App.jsx
        ├── hooks/
        │   ├── useTripleStream.js   # manages 3 hls.js instances
        │   └── useEvents.js         # fetches and navigates events
        └── components/
            ├── VideoSurface.jsx     # 3 overlaid video elements
            ├── CameraSelector.jsx   # camera tab switcher
            ├── SeekBar.jsx          # timeline with event markers
            ├── EventPanel.jsx       # bounce clip inspector panel
            └── LiveBadge.jsx        # live/paused indicator
```

## Notes

- The sync table has ~10k rows so all lookups use binary search (bisect in Python, sorted arrays)
- Sink bounce frames aren't in the CSV directly, so they're derived via the sync table
- The stream loops forever — media sequence keeps incrementing monotonically across loops so hls.js stays connected
- Review mode captures segment bytes via the hls.js `FRAG_LOADED` event — keeps the last 40 segments per camera
- Clip filenames are matched by exact name first, then by shot_id suffix as a fallback
- The existing `main.py` and original player components are preserved as-is
