#!/usr/bin/env python3
"""
tri_stream_server.py

Backend for the triple-camera live review system.
Runs three looping HLS streams on ports 8081/8082/8083 and
a FastAPI server on 8080 for sync, events, status etc.

The basic idea:
- Each camera has its own thread that loops through the .ts segments
  and writes a sliding-window live.m3u8 playlist
- Segments are symlinked from the original directories so we
  don't waste disk space copying them
- FastAPI handles the data layer (sync mapping, events, clip serving)
- We use the CSVs from the assignment (frame indices, sync table,
  flight_shots) to do cross-camera sync and event lookups
"""

import os
import csv
import time
import bisect
import shutil
import threading
import argparse
import logging
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from typing import Optional, Dict, List, Any

try:
    from fastapi import FastAPI, HTTPException, Query
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.staticfiles import StaticFiles
    import uvicorn
except ImportError as e:
    raise SystemExit(
        f"[ERROR] Missing dependency: {e}\n"
        "Run:  pip install fastapi uvicorn"
    )

# --- Path setup ---
# everything is relative to the Assignment/ root
BASE_DIR    = Path(__file__).parent.parent
DATA_DIR    = BASE_DIR / "sync_reports"
CV_DIR      = BASE_DIR / "test_work" / "cv_output"
CLIPS_DIR   = BASE_DIR / "bounce_clips_share"

STREAM_DIRS = {
    "source": DATA_DIR / "ts_segments_source" / "1645",
    "sink":   DATA_DIR / "ts_segments_sink"   / "1645",
    "hq":     DATA_DIR / "ts_segments_hq"     / "1645",
}
# these dirs get created at startup with symlinks to the actual .ts files
SERVE_DIRS = {
    "source": Path(__file__).parent / "serve_source",
    "sink":   Path(__file__).parent / "serve_sink",
    "hq":     Path(__file__).parent / "serve_hq",
}

FRAME_INDEX_FILES = {
    "source": CV_DIR / "reader" / "source" / "hls_segment_frame_index.csv",
    "sink":   CV_DIR / "reader" / "sink"   / "hls_segment_frame_index.csv",
    "hq":     CV_DIR / "reader" / "hq"     / "hls_segment_frame_index.csv",
}
TRIPLE_SYNC_FILE   = DATA_DIR / "segments_1645" / "sync" / "hls_sync_1645_triple.csv"
FLIGHT_SHOTS_FILE  = CV_DIR / "correlation" / "flight_shots.csv"

STREAM_PORTS = {"source": 8081, "sink": 8082, "hq": 8083}
API_PORT     = 8080
WINDOW_SIZE  = 30   # how many segments in the sliding HLS window

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("judex")

# --- Global state ---
# these get populated at startup by boot_all()

class StreamState:
    """Tracks what segment each camera stream is currently at."""
    def __init__(self, camera: str):
        self.camera   = camera
        self.lock     = threading.Lock()
        self.seg_idx  = 0
        self.seg_name = ""
        self.total_segs = 0
        self.playlist_time = 0.0

stream_states: Dict[str, StreamState] = {}

# per-camera frame index (from the CSV)
frame_index:  Dict[str, List[dict]] = {}

# the big sync table that maps frames across all 3 cameras
triple_sync:  List[dict] = []

# event list built from flight_shots.csv
events:       List[dict] = []

# parsed playlist data: {camera: [(duration, filename), ...]}
playlists:    Dict[str, List[tuple]] = {}


# ===== Data Loading =====

def load_playlist(camera: str) -> List[tuple]:
    """Parse a playlist.m3u8 file and return [(duration, segment_name)]."""
    pdir  = STREAM_DIRS[camera]
    pfile = pdir / "playlist.m3u8"
    segs  = []
    with open(pfile) as f:
        lines = f.read().splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith("#EXTINF:"):
            dur  = float(line.split(":")[1].rstrip(","))
            name = lines[i + 1].strip()
            segs.append((dur, name))
            i += 2
        else:
            i += 1
    return segs


def load_frame_index(camera: str) -> List[dict]:
    """Load the segment-to-frame mapping CSV. Also adds timing info
    based on the playlist durations we already parsed."""
    fpath = FRAME_INDEX_FILES[camera]
    rows  = []
    with open(fpath, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append({
                "segment_index":          int(row["segment_index"]),
                "seg_basename":           row["seg_basename"].strip(),
                "cumulative_start_frame": int(row["cumulative_start_frame"]),
                "frame_count":            int(row["frame_count"]),
            })

    # add timing data from playlist durations
    pl = playlists.get(camera, [])
    t  = 0.0
    for seg in rows:
        idx = seg["segment_index"]
        dur = pl[idx][0] if idx < len(pl) else 4.0  # default to 4s if missing
        seg["start_time_s"] = t
        seg["end_time_s"]   = t + dur
        seg["duration_s"]   = dur
        t += dur
    return rows


def load_triple_sync() -> List[dict]:
    """Load the triple-camera sync table. This thing has ~10k rows mapping
    frame indices across all three cameras. We skip any incomplete rows."""
    rows = []
    with open(TRIPLE_SYNC_FILE, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            si = row.get("Source_Index", "").strip()
            ki = row.get("Sink_Index",   "").strip()
            hi = row.get("HQ_Index",     "").strip()
            if not si or not ki or not hi:
                continue
            try:
                rows.append({
                    "source_index":   int(si),
                    "sink_index":     int(ki),
                    "hq_index":       int(hi),
                    "source_wall_ns": int(row.get("Source_Wall_ns", 0) or 0),
                    "sink_wall_ns":   int(row.get("Sink_Sensor_ns", 0) or 0),
                    "hq_wall_ns":     int(row.get("HQ_Wall_ns",     0) or 0),
                    "triple_status":  row.get("TripleStatus", "FULL"),
                })
            except ValueError:
                continue
    log.info(f"Triple sync table loaded: {len(rows)} valid rows")
    return rows


# --- Binary search lookup tables ---
# since the sync table is huge (~10k rows), doing a linear scan
# for every request would be slow. so we pre-build sorted arrays
# and use bisect for O(log n) lookups
_frame_starts: Dict[str, List[int]] = {}
_sync_keys:    Dict[str, List[int]] = {}


def _build_lookup_indices():
    """Pre-build the sorted arrays we need for binary search."""
    for cam in ("source", "sink", "hq"):
        fi = frame_index.get(cam, [])
        _frame_starts[cam] = [seg["cumulative_start_frame"] for seg in fi]

    col_map = {"source": "source_index", "sink": "sink_index", "hq": "hq_index"}
    for cam, col in col_map.items():
        _sync_keys[cam] = [row[col] for row in triple_sync]


def frame_to_time(camera: str, frame_num: int) -> Optional[float]:
    """Given a frame number, figure out what timestamp that is in the stream.
    Uses binary search since segments are sorted by start frame."""
    fi     = frame_index.get(camera, [])
    starts = _frame_starts.get(camera, [])
    if not fi or not starts:
        return None

    # find which segment this frame belongs to
    idx = bisect.bisect_right(starts, frame_num) - 1
    if idx < 0:
        idx = 0
    seg   = fi[idx]
    start = seg["cumulative_start_frame"]
    end   = start + seg["frame_count"]
    if start <= frame_num < end:
        # interpolate within the segment
        offset_in_seg = (frame_num - start) / max(seg["frame_count"], 1)
        return seg["start_time_s"] + offset_in_seg * seg["duration_s"]
    # past the end, just return the last timestamp
    return fi[-1]["end_time_s"]


def _find_nearest_sync_row(camera: str, frame_num: int) -> Optional[dict]:
    """Binary search for the sync table row closest to the given frame."""
    keys = _sync_keys.get(camera, [])
    if not keys:
        return None
    idx = bisect.bisect_left(keys, frame_num)
    # check both sides to find the actual nearest
    best_idx = idx
    if idx >= len(keys):
        best_idx = len(keys) - 1
    elif idx > 0 and abs(keys[idx - 1] - frame_num) <= abs(keys[idx] - frame_num):
        best_idx = idx - 1
    return triple_sync[best_idx]


def _source_frame_to_sink_frame(source_frame: int) -> Optional[int]:
    """The CSV doesn't have a direct sink frame column, so we look up
    the nearest sync row and grab the sink index from there."""
    if not triple_sync:
        return source_frame
    row = _find_nearest_sync_row("source", source_frame)
    return row["sink_index"] if row else source_frame


def load_events() -> List[dict]:
    """Parse flight_shots.csv and build the events list.
    For each shot, we figure out the playback timestamp for each camera
    and check which bounce clip files actually exist on disk."""
    events = []
    if not FLIGHT_SHOTS_FILE.exists():
        log.warning("flight_shots.csv not found, no events")
        return events

    with open(FLIGHT_SHOTS_FILE, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("counts_as_shot", "0").strip() != "1":
                continue

            shot_id   = row.get("shot_id", "").strip()
            flight_id = row.get("flight_id", "").strip()

            # get bounce frame for each camera
            bounce_frame_source = _safe_int(row.get("bounce_frame"))
            bounce_frame_hq     = _safe_int(row.get("bounce_hq_frame"))
            # sink frame needs to be derived via the sync table
            bounce_frame_sink   = _source_frame_to_sink_frame(bounce_frame_source) if bounce_frame_source else None

            # convert frames to playback timestamps
            ts_source = frame_to_time("source", bounce_frame_source) if bounce_frame_source else None
            ts_sink   = frame_to_time("sink",   bounce_frame_sink)   if bounce_frame_sink   else None
            ts_hq     = frame_to_time("hq",     bounce_frame_hq)     if bounce_frame_hq     else None

            bx = _safe_float(row.get("bounce_x"))
            by = _safe_float(row.get("bounce_y"))
            bz = _safe_float(row.get("bounce_z"))

            # figure out the clip filename
            # the clip files use the ORIGINAL shot_id from before filtering,
            # which doesn't match our shot_id. so we match by bounce_frame instead.
            clips = {}
            if bounce_frame_source:
                for cam in ("source", "sink", "hq"):
                    cam_dir = CLIPS_DIR / cam
                    if not cam_dir.exists():
                        continue
                    # try exact name first
                    exact = f"bounce_{bounce_frame_source}_{shot_id.zfill(5)}.mp4"
                    if (cam_dir / exact).exists():
                        clips[cam] = exact
                    else:
                        # match by bounce_frame prefix (handles mismatched shot_ids)
                        matches = list(cam_dir.glob(f"bounce_{bounce_frame_source}_*.mp4"))
                        if matches:
                            clips[cam] = matches[0].name

            events.append({
                "flight_id":     flight_id,
                "shot_id":       shot_id,
                "bounce_frame":  bounce_frame_source,
                "bounce_hq_frame": bounce_frame_hq,
                "bounce_sink_frame": bounce_frame_sink,
                "timestamps": {
                    "source": ts_source,
                    "sink":   ts_sink,
                    "hq":     ts_hq,
                },
                "bounce_coords": {"x": bx, "y": by, "z": bz},
                "clips":         clips,
                "start_frame":   _safe_int(row.get("start_frame")),
                "end_frame":     _safe_int(row.get("end_frame")),
                "counts_as_shot": True,
                "landing_confidence": _safe_float(row.get("landing_confidence")),
                "bbox": {
                    "source": {
                        "x": _safe_float(row.get("bbox_source_x")),
                        "y": _safe_float(row.get("bbox_source_y")),
                        "w": _safe_float(row.get("bbox_source_w")),
                        "h": _safe_float(row.get("bbox_source_h")),
                    },
                    "sink": {
                        "x": _safe_float(row.get("bbox_sink_x")),
                        "y": _safe_float(row.get("bbox_sink_y")),
                        "w": _safe_float(row.get("bbox_sink_w")),
                        "h": _safe_float(row.get("bbox_sink_h")),
                    },
                },
            })
    log.info(f"Loaded {len(events)} events from flight_shots.csv")
    return events


def _safe_int(v) -> Optional[int]:
    try:
        return int(float(v)) if v and str(v).strip() else None
    except (ValueError, TypeError):
        return None


def _safe_float(v) -> Optional[float]:
    try:
        return float(v) if v and str(v).strip() else None
    except (ValueError, TypeError):
        return None


# ===== Sync Logic =====

def get_segment_index_for_time(camera: str, time_s: float) -> Optional[int]:
    """Which segment is playing at a given time? Uses binary search."""
    fi = frame_index.get(camera, [])
    if not fi:
        return None
    # binary search on start_time_s (segments are sorted by time)
    lo, hi = 0, len(fi) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if fi[mid]["end_time_s"] <= time_s:
            lo = mid + 1
        elif fi[mid]["start_time_s"] > time_s:
            hi = mid - 1
        else:
            return fi[mid]["segment_index"]
    # past the end or before start
    if lo >= len(fi):
        return fi[-1]["segment_index"]
    return fi[0]["segment_index"]


def sync_cross_camera(from_camera: str, from_seg: int) -> Dict[str, Any]:
    """The core sync function. Given 'I'm at segment X on camera A',
    it tells you what segment/timestamp that corresponds to on all 3 cameras.

    How it works:
    1. Find the middle frame of the given segment
    2. Binary search the sync table for the closest row
    3. Read off the corresponding frame for each camera
    4. Convert those frames to timestamps
    """
    fi_from = frame_index.get(from_camera, [])
    if not fi_from or from_seg >= len(fi_from):
        raise ValueError(f"segment {from_seg} out of range for {from_camera}")

    fi_seg    = fi_from[from_seg]
    mid_frame = fi_seg["cumulative_start_frame"] + fi_seg["frame_count"] // 2

    # find the nearest row in the sync table
    best_row = _find_nearest_sync_row(from_camera, mid_frame)
    if not best_row:
        raise ValueError("triple sync table is empty")

    col_map = {"source": "source_index", "sink": "sink_index", "hq": "hq_index"}
    result: Dict[str, Any] = {}
    for cam in ("source", "sink", "hq"):
        target_frame = best_row[col_map[cam]]
        target_time  = frame_to_time(cam, target_frame)
        target_seg   = get_segment_index_for_time(cam, target_time) if target_time is not None else None
        result[cam] = {
            "frame":         target_frame,
            "timestamp":     target_time,
            "segment_index": target_seg,
        }
    return result


# ===== HLS Streaming =====

class CORSHTTPHandler(SimpleHTTPRequestHandler):
    """Simple HTTP handler with CORS headers and no caching.
    Needed because hls.js runs in the browser and needs CORS."""

    _serve_dir: str = "."

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=self._serve_dir, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        pass  # too noisy otherwise


def make_handler(serve_dir: str):
    """Create a handler class bound to a specific directory."""
    class _Handler(CORSHTTPHandler):
        pass
    _Handler._serve_dir = serve_dir
    return _Handler


def write_playlist(path: Path, window: List[tuple], media_sequence: int, done: bool = False):
    """Write out a live.m3u8 with the current sliding window of segments."""
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:6",
        f"#EXT-X-MEDIA-SEQUENCE:{media_sequence}",
    ]
    for dur, name in window:
        lines.append(f"#EXTINF:{dur:.6f},")
        lines.append(name)
    if done:
        lines.append("#EXT-X-ENDLIST")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def stream_loop(camera: str, speed: float = 1.0):
    """Main loop for each camera stream. Loops through the segments
    forever, maintaining a sliding window playlist.

    The key trick is that media_sequence keeps increasing monotonically
    even across loop restarts, so hls.js never sees an end-of-stream
    and stays connected indefinitely."""
    segs       = playlists[camera]
    serve_dir  = SERVE_DIRS[camera]
    src_dir    = STREAM_DIRS[camera]
    playlist_p = serve_dir / "live.m3u8"
    state      = stream_states[camera]

    state.total_segs = len(segs)

    # symlink all .ts files into the serve directory
    # (symlinks = zero extra disk space)
    for _, name in segs:
        src  = src_dir / name
        dst  = serve_dir / name
        if not dst.exists():
            try:
                dst.symlink_to(src.resolve())
            except OSError:
                shutil.copy2(src, dst)  # fallback if symlinks don't work

    log.info(f"[{camera.upper()}] serving {len(segs)} segments from port {STREAM_PORTS[camera]}")

    global_seq   = 0
    window: List[tuple] = []
    wall_time    = 0.0

    while True:
        for i, (dur, name) in enumerate(segs):
            window.append((dur, name))
            if len(window) > WINDOW_SIZE:
                window.pop(0)
                global_seq += 1

            write_playlist(playlist_p, window, global_seq)

            with state.lock:
                state.seg_idx     = i
                state.seg_name    = name
                state.playlist_time = wall_time

            time.sleep(dur / speed)
            wall_time += dur

        log.info(f"[{camera.upper()}] stream looped, restarting (seq={global_seq})")


# ===== FastAPI endpoints =====

app = FastAPI(
    title="JUDEX Triple-Camera Review API",
    version="1.0.0",
    description="Data layer for the triple-camera live review system",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)

# serve bounce clips as static files
for cam in ("source", "sink", "hq"):
    clip_dir = CLIPS_DIR / cam
    if clip_dir.exists():
        app.mount(f"/clips/{cam}", StaticFiles(directory=str(clip_dir)), name=f"clips_{cam}")


@app.get("/health")
def health():
    return {"status": "ok", "cameras": list(STREAM_PORTS.keys())}


@app.get("/cameras")
def cameras():
    """Returns the HLS playlist URLs for each camera."""
    return {
        "source": f"http://localhost:{STREAM_PORTS['source']}/live.m3u8",
        "sink":   f"http://localhost:{STREAM_PORTS['sink']}/live.m3u8",
        "hq":     f"http://localhost:{STREAM_PORTS['hq']}/live.m3u8",
    }


@app.get("/status")
def status():
    """What segment is each camera currently streaming?"""
    out = {}
    for cam, st in stream_states.items():
        with st.lock:
            out[cam] = {
                "segment_index":   st.seg_idx,
                "segment_name":    st.seg_name,
                "total_segments":  st.total_segs,
                "playlist_time_s": round(st.playlist_time, 3),
            }
    return out


@app.get("/sync")
def sync(
    from_camera: str = Query(..., description="source | sink | hq"),
    from_seg:    int = Query(..., description="segment index on from_camera"),
):
    """Map a segment on one camera to the equivalent position on all others."""
    from_camera = from_camera.lower()
    if from_camera not in ("source", "sink", "hq"):
        raise HTTPException(status_code=400, detail="from_camera must be source | sink | hq")
    try:
        result = sync_cross_camera(from_camera, from_seg)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return result


@app.get("/sync_time")
def sync_time(
    from_camera: str   = Query(..., description="source | sink | hq"),
    from_time:   float = Query(..., description="playback time in seconds"),
):
    """Same as /sync but takes a timestamp instead of segment index.
    This is what the frontend actually uses since it knows video.currentTime."""
    from_camera = from_camera.lower()
    if from_camera not in ("source", "sink", "hq"):
        raise HTTPException(status_code=400, detail="from_camera must be source | sink | hq")

    seg_idx = get_segment_index_for_time(from_camera, from_time)
    if seg_idx is None:
        raise HTTPException(status_code=422, detail=f"No segment at time {from_time} for {from_camera}")

    try:
        result = sync_cross_camera(from_camera, seg_idx)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return result


@app.get("/events")
def get_events(
    min_confidence: float = Query(0.0, description="Filter by minimum landing confidence"),
    limit: int = Query(0, description="Max events (0 = all)"),
):
    """All the shot events with timestamps, coords, clip filenames etc."""
    out = events
    if min_confidence > 0:
        out = [e for e in out if (e.get("landing_confidence") or 0) >= min_confidence]
    if limit > 0:
        out = out[:limit]
    return {"events": out, "total": len(out)}


@app.get("/events/{shot_id}")
def get_event(shot_id: str):
    """Get a single event by its shot_id."""
    for ev in events:
        if str(ev["shot_id"]) == str(shot_id):
            return ev
    raise HTTPException(status_code=404, detail=f"shot_id {shot_id!r} not found")


@app.get("/frame_to_time/{camera}/{frame}")
def frame_to_time_api(camera: str, frame: int):
    """Helper endpoint to convert a frame number to a timestamp."""
    camera = camera.lower()
    if camera not in frame_index:
        raise HTTPException(status_code=400, detail=f"Unknown camera: {camera}")
    t = frame_to_time(camera, frame)
    seg = get_segment_index_for_time(camera, t) if t is not None else None
    return {"camera": camera, "frame": frame, "timestamp": t, "segment_index": seg}


# ===== Startup =====

def boot_all(speed: float = 1.0):
    """Load all the data and spin up the stream threads."""
    global frame_index, triple_sync, events

    # load playlists first (we need durations for the frame index)
    for cam in ("source", "sink", "hq"):
        playlists[cam] = load_playlist(cam)
        log.info(f"Playlist [{cam}]: {len(playlists[cam])} segments")

    # load frame indices
    for cam in ("source", "sink", "hq"):
        frame_index[cam] = load_frame_index(cam)

    # load the sync table
    triple_sync = load_triple_sync()
    log.info(f"Triple sync table: {len(triple_sync)} rows")

    # build the binary search indices
    _build_lookup_indices()
    log.info("Binary search indices ready")

    # load events
    events = load_events()

    # set up serve directories
    for cam, sd in SERVE_DIRS.items():
        sd.mkdir(exist_ok=True)
        pl = sd / "live.m3u8"
        if not pl.exists():
            write_playlist(pl, [], 0)

    # init stream states
    for cam in ("source", "sink", "hq"):
        stream_states[cam] = StreamState(cam)

    # start the stream loops (daemon threads so they die with main)
    for cam in ("source", "sink", "hq"):
        t = threading.Thread(target=stream_loop, args=(cam, speed), daemon=True, name=f"stream-{cam}")
        t.start()

    # start the HTTP servers for each camera
    for cam, port in STREAM_PORTS.items():
        serve_dir = str(SERVE_DIRS[cam])
        handler   = make_handler(serve_dir)
        server    = HTTPServer(("", port), handler)
        t = threading.Thread(target=server.serve_forever, daemon=True, name=f"http-{cam}")
        t.start()
        log.info(f"[{cam.upper()}] HLS server on http://localhost:{port}/live.m3u8")


def main():
    parser = argparse.ArgumentParser(description="JUDEX Triple-Camera Stream Server")
    parser.add_argument("--speed",   type=float, default=1.0,
                        help="Playback speed multiplier (default: 1.0)")
    parser.add_argument("--api-port", type=int, default=API_PORT,
                        help="FastAPI port (default: 8080)")
    args = parser.parse_args()

    boot_all(speed=args.speed)

    log.info(f"FastAPI on http://localhost:{args.api_port}")
    log.info("Press Ctrl+C to stop.")

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=args.api_port,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
