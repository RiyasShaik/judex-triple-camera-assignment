/*
 * useTripleStream.js
 *
 * Manages 3 hls.js instances for the triple camera system.
 *
 * All 3 cameras stay connected and buffering at all times.
 * Switching = seek + opacity swap, no reconnection.
 *
 * Review mode: destroy live instances, build VOD from buffered bytes.
 * Uses a custom in-memory loader so hls.js doesn't make ANY network
 * requests (not even to blob URLs) — the Network tab stays completely clean.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import Hls from 'hls.js'

const API_BASE = 'http://localhost:8080'

export const CAMERAS = ['source', 'sink', 'hq']
export const CAMERA_LABELS = { source: 'SOURCE', sink: 'SINK', hq: 'HQ' }
export const CAMERA_COLORS = { source: '#3b9eff', sink: '#22d06e', hq: '#f5a623' }

const REVIEW_BUFFER_SIZE = 40

const LIVE_CONFIG = {
  backBufferLength:            120,
  maxBufferLength:             120,
  maxMaxBufferLength:          300,
  liveSyncDurationCount:        3,
  liveMaxLatencyDurationCount:  6,
  enableWorker:                true,
  lowLatencyMode:              false,
  // auto-recover from buffer stalls (common when stream loops)
  nudgeMaxRetry:                10,
}

// ---- In-memory loader for review mode ----
// This is the key to getting ZERO network tab entries.
// We store all playlist/segment data in this map, and hls.js
// reads directly from it instead of making XHR requests.
const _reviewStore = new Map()

class MemoryLoader {
  constructor(config) {
    this.config = config
    this.stats = { loaded: 0, total: 0, loading: { start: 0, first: 0, end: 0 },
                   parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } }
    this.context = null
    this.callbacks = null
  }
  destroy() {}
  abort() {}
  load(context, config, callbacks) {
    this.context = context
    this.callbacks = callbacks
    const data = _reviewStore.get(context.url)
    if (data != null) {
      const now = performance.now()
      const len = typeof data === 'string' ? data.length : (data.byteLength ?? 0)
      const stats = {
        loaded: len, total: len, retry: 0,
        loading: { start: now, first: now, end: now },
        parsing: { start: now, end: now },
        buffering: { start: now, first: now, end: now },
      }
      // for playlists hls.js expects a string, for fragments an ArrayBuffer
      const response = { url: context.url, data: data }
      // use setTimeout(0) so hls.js processes it asynchronously (it expects that)
      setTimeout(() => callbacks.onSuccess(response, stats, context, null), 0)
    } else {
      setTimeout(() => callbacks.onError(
        { code: 404, text: `Not in memory store: ${context.url}` },
        context, null
      ), 0)
    }
  }
}

function buildVodPlaylist(segments, segKeys) {
  const lines = [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
  ]
  for (let i = 0; i < segments.length; i++) {
    lines.push(`#EXTINF:${segments[i].duration.toFixed(6)},`)
    lines.push(segKeys[i])  // absolute URL keys into the memory store
  }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n')
}


export default function useTripleStream(streamUrls) {
  const hlsRefs   = useRef({ source: null, sink: null, hq: null })
  const videoRefs = useRef({ source: null, hq: null, sink: null })

  // rolling buffer: [{sn, originalStart, duration, bytes}]
  const rollingBufs = useRef({ source: [], sink: [], hq: [] })

  // blob URLs (only used for m3u8 playlist URL in review mode, not segments)
  const blobUrlsRef = useRef([])

  const reviewSegsRef = useRef({ source: [], sink: [], hq: [] })

  // refs to avoid stale closures
  const modeRef = useRef('live')
  const activeCamRef = useRef('source')

  // state
  const [activeCamera,  setActiveCamera]  = useState('source')
  const [mode,          setMode]          = useState('live')
  const [streamStatus,  setStreamStatus]  = useState({
    source: 'connecting', sink: 'connecting', hq: 'connecting',
  })
  const [liveEdges,     setLiveEdges]     = useState({ source: null, sink: null, hq: null })
  const [currentTimes,  setCurrentTimes]  = useState({ source: 0, sink: 0, hq: 0 })
  const [liveSegments,  setLiveSegments]  = useState({ source: [], sink: [], hq: [] })
  const [reviewSegs,    setReviewSegs]    = useState({ source: [], sink: [], hq: [] })
  const [isPaused,      setIsPaused]      = useState(false)

  const rafRef = useRef(null)

  useEffect(() => { activeCamRef.current = activeCamera }, [activeCamera])

  const setVideoRef = useCallback((cam, el) => {
    videoRefs.current[cam] = el
  }, [])

  // RAF tick
  const tick = useCallback(() => {
    const times = {}
    const edges = {}
    for (const cam of CAMERAS) {
      const video = videoRefs.current[cam]
      const hls   = hlsRefs.current[cam]
      if (video) times[cam] = video.currentTime
      if (hls && modeRef.current === 'live') {
        const pos = hls.liveSyncPosition
        if (pos != null && Number.isFinite(pos)) edges[cam] = pos
      }
    }
    const active = videoRefs.current[activeCamRef.current]
    if (active) setIsPaused(active.paused)
    setCurrentTimes(prev => ({ ...prev, ...times }))
    setLiveEdges(prev => ({ ...prev, ...edges }))
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  // init one live hls instance
  const initOneLive = useCallback((cam) => {
    const url   = streamUrls[cam]
    const video = videoRefs.current[cam]
    if (!url || !video) return

    const hls = new Hls(LIVE_CONFIG)
    hlsRefs.current[cam] = hls
    hls.loadSource(url)
    hls.attachMedia(video)

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setStreamStatus(p => ({ ...p, [cam]: 'playing' }))
      if (cam === activeCamRef.current) {
        video.play().catch(() => {})
      } else {
        video.muted = true
        video.play().catch(() => {})
      }
    })

    // capture segment bytes for review mode
    hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
      const payload = data?.payload
                   ?? data?.frag?.loader?.response?.data
                   ?? null
      if (!payload || !payload.byteLength) return
      const entry = {
        sn:            data.frag.sn,
        originalStart: data.frag.start,
        duration:      data.frag.duration,
        bytes:         payload.slice(0),
      }
      const next = [...rollingBufs.current[cam], entry].slice(-REVIEW_BUFFER_SIZE)
      rollingBufs.current[cam] = next
      setLiveSegments(prev => ({
        ...prev,
        [cam]: next.map(s => ({ sn: s.sn, start: s.originalStart, end: s.originalStart + s.duration })),
      }))
    })

    // auto-recover from errors and buffer stalls
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (modeRef.current !== 'live') return
      if (data.details === 'bufferStalledError' || data.details === 'bufferNudgeOnStall') {
        // just let hls.js handle stalls internally, don't show error
        return
      }
      if (data.fatal) {
        setStreamStatus(p => ({ ...p, [cam]: 'error' }))
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          console.warn(`[${cam}] network error, retrying...`)
          setTimeout(() => hls.startLoad(), 2000)
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          console.warn(`[${cam}] media error, recovering...`)
          hls.recoverMediaError()
        }
      }
    })

    // auto-recover from buffer stalls that freeze the video
    // this handles the "video stops after a while" issue
    let stallCheck = setInterval(() => {
      if (modeRef.current !== 'live') { clearInterval(stallCheck); return }
      if (!video || video.paused) return
      if (video.readyState <= 2 && hls.media) {
        // video is stalled, try to nudge it
        const syncPos = hls.liveSyncPosition
        if (syncPos && Number.isFinite(syncPos) && Math.abs(video.currentTime - syncPos) > 10) {
          video.currentTime = syncPos - 2
          console.warn(`[${cam}] stall detected, jumping to sync position`)
        }
      }
    }, 5000)
  }, [streamUrls])

  const initAllLive = useCallback(() => {
    for (const cam of CAMERAS) initOneLive(cam)
    modeRef.current = 'live'
    setMode('live')
  }, [initOneLive])

  // camera switching
  const switchCamera = useCallback(async (toCam) => {
    const fromCam = activeCamRef.current
    if (toCam === fromCam) return
    const fromVid = videoRefs.current[fromCam]

    activeCamRef.current = toCam
    setActiveCamera(toCam)

    const toVideo = videoRefs.current[toCam]
    if (!toVideo) return

    if (modeRef.current === 'review') {
      // map positions using originalStart metadata (no network!)
      const fromTime = fromVid?.currentTime ?? 0
      const fromSegs = reviewSegsRef.current[fromCam] || []
      const toSegs   = reviewSegsRef.current[toCam]   || []

      let originalTime = null
      for (const seg of fromSegs) {
        if (fromTime >= seg.start && fromTime < seg.end) {
          originalTime = seg.originalStart + (fromTime - seg.start)
          break
        }
      }
      if (originalTime == null && fromSegs.length > 0) {
        const last = fromSegs[fromSegs.length - 1]
        originalTime = last.originalStart + last.duration
      }

      if (originalTime != null && toSegs.length > 0) {
        let mapped = false
        for (const seg of toSegs) {
          if (originalTime >= seg.originalStart && originalTime < seg.originalStart + seg.duration) {
            toVideo.currentTime = seg.start + (originalTime - seg.originalStart)
            mapped = true
            break
          }
        }
        if (!mapped) {
          toVideo.currentTime = originalTime < toSegs[0].originalStart
            ? toSegs[0].start
            : toSegs[toSegs.length - 1].end - 0.1
        }
      } else {
        toVideo.currentTime = fromVid?.currentTime ?? 0
      }
    } else {
      // live mode: use /sync_time API
      const fromTime = fromVid?.currentTime ?? 0
      try {
        const res  = await fetch(
          `${API_BASE}/sync_time?from_camera=${fromCam}&from_time=${fromTime.toFixed(3)}`
        )
        const data = await res.json()
        const ts   = data[toCam]?.timestamp
        if (ts != null && Number.isFinite(ts)) toVideo.currentTime = ts
      } catch {
        if (fromVid) toVideo.currentTime = fromVid.currentTime
      }
    }

    toVideo.muted = false
    await toVideo.play().catch(() => {})
    if (fromVid) fromVid.muted = true
  }, [])

  // --- Review mode (ZERO network requests) ---
  // Uses MemoryLoader so hls.js reads directly from RAM
  const enterReview = useCallback(() => {
    const newReviewSegs = {}

    // destroy all live connections
    for (const cam of CAMERAS) {
      hlsRefs.current[cam]?.stopLoad()
      hlsRefs.current[cam]?.destroy()
      hlsRefs.current[cam] = null
    }

    // snapshot buffers
    const bufSnapshots = {}
    for (const cam of CAMERAS) {
      bufSnapshots[cam] = rollingBufs.current[cam].slice()
    }

    // clear the memory store from any previous review
    _reviewStore.clear()

    for (const cam of CAMERAS) {
      const buf = bufSnapshots[cam]
      if (buf.length === 0) {
        newReviewSegs[cam] = []
        continue
      }

      // store each segment's bytes in the memory store
      const segKeys = buf.map((s, i) => {
        const key = `http://review.local/${cam}/seg_${i}.ts`
        _reviewStore.set(key, s.bytes)
        return key
      })

      // build m3u8 playlist referencing those keys
      const m3u8 = buildVodPlaylist(buf, segKeys)
      const playlistKey = `http://review.local/${cam}/playlist.m3u8`
      _reviewStore.set(playlistKey, m3u8)

      // build local timeline
      let t = 0
      const local = buf.map(s => {
        const seg = { sn: s.sn, start: t, end: t + s.duration, duration: s.duration, originalStart: s.originalStart }
        t += s.duration
        return seg
      })
      newReviewSegs[cam] = local
      reviewSegsRef.current[cam] = local

      // create hls.js with our custom loader — NO XHR, NO fetch
      const video = videoRefs.current[cam]
      const hls = new Hls({
        enableWorker:    false,  // workers can't access our memory store
        maxBufferLength: 120,
        backBufferLength: 120,
        loader:          MemoryLoader,  // <-- the magic: all loads go through RAM
      })
      hlsRefs.current[cam] = hls
      hls.loadSource(playlistKey)
      hls.attachMedia(video)
      hls.once(Hls.Events.MANIFEST_PARSED, () => {
        video.currentTime = 0
        if (cam === activeCamRef.current) video.pause()
      })
    }

    setReviewSegs(newReviewSegs)
    modeRef.current = 'review'
    setMode('review')
  }, [])

  // go back to live
  const exitReview = useCallback(() => {
    for (const cam of CAMERAS) {
      hlsRefs.current[cam]?.destroy()
      hlsRefs.current[cam] = null
    }
    // clear the memory store
    _reviewStore.clear()
    blobUrlsRef.current.forEach(u => {
      try { URL.revokeObjectURL(u) } catch { /* noop */ }
    })
    blobUrlsRef.current = []
    for (const cam of CAMERAS) rollingBufs.current[cam] = []
    setReviewSegs({ source: [], sink: [], hq: [] })
    setLiveSegments({ source: [], sink: [], hq: [] })
    setStreamStatus({ source: 'connecting', sink: 'connecting', hq: 'connecting' })
    initAllLive()
  }, [initAllLive])

  const seekActive = useCallback((time) => {
    const video = videoRefs.current[activeCamRef.current]
    if (video) video.currentTime = time
  }, [])

  const togglePlayPause = useCallback(() => {
    const video = videoRefs.current[activeCamRef.current]
    if (!video) return
    video.paused ? video.play().catch(() => {}) : video.pause()
  }, [])

  const jumpToLive = useCallback(() => {
    const cam   = activeCamRef.current
    const video = videoRefs.current[cam]
    const hls   = hlsRefs.current[cam]
    if (!video || !hls) return
    const details  = hls.levels?.[hls.currentLevel]?.details
    const lastFrag = details?.fragments?.[details.fragments.length - 1]
    if (lastFrag) video.currentTime = lastFrag.start
    else if (Number.isFinite(hls.liveSyncPosition)) video.currentTime = hls.liveSyncPosition
    video.play().catch(() => {})
  }, [])

  // mount / unmount
  useEffect(() => {
    if (!Hls.isSupported()) {
      console.error('hls.js not supported')
      return
    }
    const timer = setTimeout(() => {
      initAllLive()
      rafRef.current = requestAnimationFrame(tick)
    }, 200)

    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(rafRef.current)
      for (const cam of CAMERAS) hlsRefs.current[cam]?.destroy()
      _reviewStore.clear()
      blobUrlsRef.current.forEach(u => {
        try { URL.revokeObjectURL(u) } catch { /* noop */ }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  // derived values
  const inReview = mode === 'review'
  const activeLiveEdge    = liveEdges[activeCamera]
  const activeCurrentTime = currentTimes[activeCamera]
  const isAtLive = !inReview && activeLiveEdge != null && activeCurrentTime >= activeLiveEdge - 2

  const displaySegs     = inReview ? reviewSegs[activeCamera]   : liveSegments[activeCamera]
  const displayEdge     = inReview ? (reviewSegs[activeCamera]?.at(-1)?.end ?? null) : activeLiveEdge
  const displayBufStart = inReview ? (reviewSegs[activeCamera]?.[0]?.start ?? null) : null

  return {
    videoRefs, setVideoRef,
    activeCamera, setActiveCamera,
    switchCamera,
    mode, inReview,
    streamStatus,
    currentTimes, activeCurrentTime,
    liveEdges, activeLiveEdge,
    isAtLive,
    isPaused,
    liveSegments, reviewSegs,
    displaySegs, displayEdge, displayBufStart,
    enterReview, exitReview,
    seekActive, togglePlayPause, jumpToLive,
    rollingBufs,
  }
}
