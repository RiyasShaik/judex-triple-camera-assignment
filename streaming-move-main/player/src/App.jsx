/*
 * App.jsx
 * Main layout component. Has the header with camera tabs,
 * the video area, seek bar with event markers, and the
 * slide-up event panel for bounce clip inspection.
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import useTripleStream, { CAMERA_COLORS } from './hooks/useTripleStream'
import useEvents from './hooks/useEvents'
import VideoSurface  from './components/VideoSurface'
import CameraSelector from './components/CameraSelector'
import SeekBar        from './components/SeekBar'
import EventPanel     from './components/EventPanel'
import LiveBadge      from './components/LiveBadge'

const API_BASE = 'http://localhost:8080'

// ── Stream URLs (will be fetched from API, fallback to defaults)
const DEFAULT_URLS = {
  source: 'http://localhost:8081/live.m3u8',
  sink:   'http://localhost:8082/live.m3u8',
  hq:     'http://localhost:8083/live.m3u8',
}

export default function App() {
  const [streamUrls,     setStreamUrls]     = useState(DEFAULT_URLS)
  const [apiConnected,   setApiConnected]   = useState(false)
  const [showControls,   setShowControls]   = useState(true)
  const [eventPanelOpen, setEventPanelOpen] = useState(false)
  const [selectedEvent,  setSelectedEvent]  = useState(null)
  const [selectedEventIdx, setSelectedEventIdx] = useState(null)
  const [showSegList,    setShowSegList]    = useState(false)
  const hoverTimer = useRef(null)

  // ── Triple stream hook
  const stream = useTripleStream(streamUrls)

  // ── Events hook
  const evts = useEvents()

  // ── Fetch camera URLs from API
  useEffect(() => {
    fetch(`${API_BASE}/cameras`)
      .then(r => r.json())
      .then(data => {
        setStreamUrls({
          source: data.source || DEFAULT_URLS.source,
          sink:   data.sink   || DEFAULT_URLS.sink,
          hq:     data.hq     || DEFAULT_URLS.hq,
        })
        setApiConnected(true)
      })
      .catch(() => {
        console.warn('[app] API not reachable — using default URLs')
        setApiConnected(false)
      })
  }, [])

  // hide controls after a few seconds of no mouse movement
  const showControlsFor = useCallback((ms = 3000) => {
    clearTimeout(hoverTimer.current)
    setShowControls(true)
    hoverTimer.current = setTimeout(() => setShowControls(false), ms)
  }, [])

  const handleMouseMove = useCallback(() => showControlsFor(3000), [showControlsFor])
  const handleMouseEnter = useCallback(() => { clearTimeout(hoverTimer.current); setShowControls(true) }, [])
  const handleMouseLeave = useCallback(() => { hoverTimer.current = setTimeout(() => setShowControls(false), 2000) }, [])

  // review mode handlers
  const handleEnterReview = useCallback(() => {
    stream.enterReview()
  }, [stream])

  const handleGoLive = useCallback(() => {
    setEventPanelOpen(false)
    setSelectedEvent(null)
    stream.exitReview()
  }, [stream])

  // event panel stuff
  const openEvent = useCallback((idx, ev) => {
    setSelectedEventIdx(idx)
    setSelectedEvent(ev)
    setEventPanelOpen(true)
    // Also seek active camera to the event timestamp
    const ts = ev.timestamps?.[stream.activeCamera]
    if (ts != null) stream.seekActive(ts)
    stream.videoRefs.current[stream.activeCamera]?.pause()
  }, [stream])

  const closeEventPanel = useCallback(() => {
    setEventPanelOpen(false)
    setSelectedEvent(null)
  }, [])

  // keep refs for keyboard handler (avoids stale closures and constant re-registration)
  const streamRef = useRef(stream)
  const evtsRef = useRef(evts)
  const panelOpenRef = useRef(eventPanelOpen)
  useEffect(() => { streamRef.current = stream }, [stream])
  useEffect(() => { evtsRef.current = evts }, [evts])
  useEffect(() => { panelOpenRef.current = eventPanelOpen }, [eventPanelOpen])

  const handlePrevEvent = useCallback(() => {
    const s = streamRef.current
    const e = evtsRef.current
    const idx = e.goPrevEvent(s.activeCamera, s.activeCurrentTime)
    if (idx != null) openEvent(idx, e.events[idx])
  }, [openEvent])

  const handleNextEvent = useCallback(() => {
    const s = streamRef.current
    const e = evtsRef.current
    const idx = e.goNextEvent(s.activeCamera, s.activeCurrentTime)
    if (idx != null) openEvent(idx, e.events[idx])
  }, [openEvent])

  const handlePanelPrev = useCallback(() => {
    if (selectedEventIdx > 0) {
      const idx = selectedEventIdx - 1
      const ev  = evtsRef.current.events[idx]
      openEvent(idx, ev)
    }
  }, [selectedEventIdx, openEvent])

  const handlePanelNext = useCallback(() => {
    const events = evtsRef.current.events
    if (selectedEventIdx < events.length - 1) {
      const idx = selectedEventIdx + 1
      openEvent(idx, events[idx])
    }
  }, [selectedEventIdx, openEvent])

  // single keyboard handler registered once, reads latest values from refs
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const s = streamRef.current

      if (e.code === 'Space') {
        e.preventDefault()
        s.togglePlayPause()
      }
      if (e.key === 'Escape' && panelOpenRef.current) {
        setEventPanelOpen(false)
        setSelectedEvent(null)
      }
      // arrow keys for event navigation
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const idx = evtsRef.current.goPrevEvent(s.activeCamera, s.activeCurrentTime)
        if (idx != null) openEvent(idx, evtsRef.current.events[idx])
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        const idx = evtsRef.current.goNextEvent(s.activeCamera, s.activeCurrentTime)
        if (idx != null) openEvent(idx, evtsRef.current.events[idx])
      }
      // camera switching: 1 = SOURCE, 2 = SINK, 3 = HQ
      if (e.key === '1') s.switchCamera('source')
      if (e.key === '2') s.switchCamera('sink')
      if (e.key === '3') s.switchCamera('hq')
      // review mode toggle
      if (e.key === 'r' || e.key === 'R') {
        if (s.inReview) {
          setEventPanelOpen(false)
          setSelectedEvent(null)
          s.exitReview()
        } else {
          s.enterReview()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [openEvent])   // openEvent is stable (only depends on stream.seekActive)

  // rough memory estimate for the status bar
  const rollingCount = Object.values(stream.rollingBufs.current)
    .reduce((acc, buf) => acc + buf.length, 0)
  const memMB = stream.inReview
    ? (Object.values(stream.reviewSegs).flat().length * 2)
    : Math.round(Object.values(stream.rollingBufs.current)
        .flatMap(b => b)
        .reduce((acc, s) => acc + (s.bytes?.byteLength ?? 0), 0) / (1024 * 1024))

  const panelOpen = eventPanelOpen && selectedEvent != null
  const activeColor = CAMERA_COLORS[stream.activeCamera]

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column',
        height: '100vh', overflow: 'hidden',
        background: 'var(--bg)',
      }}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >

      {/* --- HEADER --- */}
      <header style={{
        display:       'flex',
        alignItems:    'center',
        gap:            12,
        padding:       '8px 16px',
        borderBottom:  '1px solid var(--border)',
        flexShrink:     0,
        background:    'var(--surface)',
        zIndex:         50,
      }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 6,
            background: `linear-gradient(135deg, ${activeColor}44, ${activeColor}22)`,
            border: `1px solid ${activeColor}44`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.3s ease',
          }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>🎾</span>
          </div>
          <div>
            <div style={{
              fontFamily: 'var(--condensed)', fontSize: 13,
              fontWeight: 600, letterSpacing: '0.2em',
              textTransform: 'uppercase', color: 'var(--text)',
              lineHeight: 1.2,
            }}>
              JUDEX
            </div>
            <div style={{
              fontFamily: 'var(--condensed)', fontSize: 9,
              letterSpacing: '0.15em', color: 'var(--muted)',
              textTransform: 'uppercase',
            }}>
              Triple-Camera Review
            </div>
          </div>
        </div>

        <div style={{ width: 1, height: 24, background: 'var(--border)', margin: '0 4px' }} />

        {/* Camera selector */}
        <CameraSelector
          activeCamera={stream.activeCamera}
          onSwitch={stream.switchCamera}
          streamStatus={stream.streamStatus}
          liveSegments={stream.liveSegments}
          mode={stream.mode}
        />

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* System status chips */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* API status */}
          <StatusChip
            label={apiConnected ? 'API' : 'API'}
            color={apiConnected ? 'var(--green)' : 'var(--muted2)'}
            active={apiConnected}
          />

          {/* Events count */}
          {evts.events.length > 0 && (
            <StatusChip
              label={`${evts.events.length} shots`}
              color="var(--amber)"
              active={true}
            />
          )}

          {/* Memory */}
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 9,
            color: 'var(--muted2)', padding: '2px 6px',
            background: 'rgba(255,255,255,0.03)',
            borderRadius: 3, border: '1px solid var(--border)',
          }}>
            mem {memMB} MB
          </span>

          {/* Review mode toggle */}
          {stream.inReview ? (
            <button
              id="go-live-btn"
              onClick={handleGoLive}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'var(--red)', border: 'none',
                borderRadius: 4, padding: '5px 12px',
                cursor: 'pointer',
                fontFamily: 'var(--condensed)', fontSize: 11,
                fontWeight: 600, letterSpacing: '0.12em',
                color: '#fff', textTransform: 'uppercase',
              }}
            >
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: '#fff',
                animation: 'pulse 1.4s ease-in-out infinite',
              }} />
              Go Live
            </button>
          ) : (
            <button
              id="review-mode-btn"
              onClick={handleEnterReview}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'rgba(245,166,35,0.12)',
                border: '1px solid rgba(245,166,35,0.3)',
                borderRadius: 4, padding: '4px 12px',
                cursor: 'pointer',
                fontFamily: 'var(--condensed)', fontSize: 11,
                fontWeight: 600, letterSpacing: '0.12em',
                color: 'var(--amber)', textTransform: 'uppercase',
              }}
            >
              ⊙ Review
            </button>
          )}
        </div>
      </header>

      {/* --- VIDEO AREA --- */}
      <div style={{
        position: 'relative',
        flex: 1, minHeight: 0,
        overflow: 'hidden',
      }}>
        <VideoSurface
          setVideoRef={stream.setVideoRef}
          activeCamera={stream.activeCamera}
          streamStatus={stream.streamStatus}
          mode={stream.mode}
        />

        {/* ── Controls overlay ─────────────────── */}
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          padding: panelOpen ? '0' : '24px 20px 16px',
          background: panelOpen ? 'none' : 'linear-gradient(to top, rgba(9,11,15,0.9) 0%, transparent 100%)',
          opacity: showControls || stream.isPaused || panelOpen ? 1 : 0,
          transition: 'opacity 0.3s ease',
          pointerEvents: showControls || stream.isPaused || panelOpen ? 'auto' : 'none',
          zIndex: 20,
        }}>

          {/* Event panel */}
          {panelOpen && (
            <EventPanel
              event={selectedEvent}
              eventIndex={selectedEventIdx}
              totalEvents={evts.events.length}
              onClose={closeEventPanel}
              onPrev={handlePanelPrev}
              onNext={handlePanelNext}
            />
          )}

          {/* Playback controls row */}
          {!panelOpen && (
            <>
              <div style={{
                display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', marginBottom: 10,
              }}>
                {/* Left: Live badge + Play/Pause */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <LiveBadge
                    isLive={stream.isAtLive}
                    isPaused={stream.isPaused}
                    onClick={stream.inReview ? handleGoLive : stream.jumpToLive}
                  />
                  <button
                    id="play-pause-btn"
                    onClick={stream.togglePlayPause}
                    style={{
                      width: 28, height: 28, borderRadius: '50%',
                      background: 'rgba(255,255,255,0.08)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: 'var(--text)', fontSize: 11,
                      cursor: 'pointer', display: 'flex',
                      alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    {stream.isPaused ? '▶' : '⏸'}
                  </button>
                </div>

                {/* Center: camera indicator */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{
                    width: 7, height: 7, borderRadius: '50%',
                    background: activeColor,
                    animation: !stream.isPaused ? 'pulse 2s ease-in-out infinite' : 'none',
                  }} />
                  <span style={{
                    fontFamily: 'var(--condensed)', fontSize: 11,
                    color: activeColor, letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                  }}>
                    {stream.activeCamera.toUpperCase()}
                  </span>
                </div>

                {/* Right: buffer info + event panel toggle */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)' }}>
                  <span>
                    buf{' '}
                    <span style={{ color: activeColor }}>
                      {stream.displaySegs?.length ?? 0}
                    </span>
                  </span>
                  {evts.events.length > 0 && (
                    <button
                      id="event-panel-toggle"
                      onClick={() => {
                        // Open event nearest to current time
                        const idx = evts.findNearestEvent(stream.activeCamera, stream.activeCurrentTime)
                        if (idx != null) openEvent(idx, evts.events[idx])
                      }}
                      style={{
                        background: 'rgba(245,166,35,0.1)',
                        border: '1px solid rgba(245,166,35,0.25)',
                        borderRadius: 3, padding: '3px 9px',
                        cursor: 'pointer',
                        fontFamily: 'var(--condensed)', fontSize: 10,
                        color: 'var(--amber)', letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                      }}
                    >
                      ◉ Events
                    </button>
                  )}
                </div>
              </div>

              {/* SeekBar */}
              <SeekBar
                currentTime={stream.activeCurrentTime}
                liveEdge={stream.displayEdge}
                bufferStart={stream.displayBufStart}
                bufferedEnd={null}
                segments={stream.displaySegs}
                events={evts.events}
                activeCamera={stream.activeCamera}
                activeEventIdx={selectedEventIdx}
                onSeek={stream.seekActive}
                onPrevEvent={handlePrevEvent}
                onNextEvent={handleNextEvent}
                onEventClick={openEvent}
                inReview={stream.inReview}
              />
            </>
          )}
        </div>
      </div>

      {/* --- STATUS BAR --- */}
      <div style={{
        display:       'flex',
        alignItems:    'center',
        gap:            12,
        padding:       '4px 16px',
        borderTop:     '1px solid var(--border)',
        background:    'var(--surface)',
        flexShrink:     0,
        fontSize:       9,
        fontFamily:    'var(--font-mono)',
        color:         'var(--muted2)',
      }}>
        <span style={{ color: stream.inReview ? 'var(--amber)' : 'var(--green)' }}>
          {stream.inReview ? '● REVIEW' : '● LIVE'}
        </span>
        <span>·</span>
        <span>{stream.activeCamera.toUpperCase()}</span>
        <span>·</span>
        <span>
          t={stream.activeCurrentTime.toFixed(2)}s
        </span>
        {stream.activeLiveEdge && (
          <>
            <span>·</span>
            <span>edge={stream.activeLiveEdge.toFixed(1)}s</span>
          </>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--muted2)' }}>
          ⌨ Space·Play  ←→·Events  1·2·3·Cam  R·Review
        </span>
        <span style={{ marginLeft: 8 }}>
          JUDEX · Triple-Camera Live Review System
        </span>
      </div>
    </div>
  )
}

function StatusChip({ label, color, active }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '2px 8px',
      background: active ? `${color}15` : 'rgba(255,255,255,0.03)',
      border: `1px solid ${active ? `${color}30` : 'var(--border)'}`,
      borderRadius: 3,
    }}>
      <div style={{
        width: 5, height: 5, borderRadius: '50%',
        background: color,
        animation: active ? 'pulse 2s ease-in-out infinite' : 'none',
      }} />
      <span style={{
        fontFamily: 'var(--condensed)', fontSize: 9,
        letterSpacing: '0.1em', textTransform: 'uppercase',
        color,
      }}>{label}</span>
    </div>
  )
}
