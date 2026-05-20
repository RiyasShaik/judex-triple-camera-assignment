/*
 * EventPanel.jsx
 * The slide-up panel that shows bounce clips from all 3 cameras
 * when you click on an event. Has synchronized playback, loop toggle,
 * and a metadata sidebar showing shot info.
 */
import { useRef, useState, useCallback, useEffect } from 'react'
import { CAMERAS, CAMERA_LABELS, CAMERA_COLORS } from '../hooks/useTripleStream'

const CLIPS_BASE = 'http://localhost:8080/clips'

export default function EventPanel({ event, onClose, onPrev, onNext, eventIndex, totalEvents }) {
  const videoRefs  = useRef({})
  const [playing,  setPlaying]  = useState(false)
  const [looping,  setLooping]  = useState(true)
  const [errored,  setErrored]  = useState({})

  // reset when we navigate to a different event
  useEffect(() => {
    setPlaying(false)
    setErrored({})
    Object.values(videoRefs.current).forEach(v => {
      if (v) { v.currentTime = 0; v.pause() }
    })
  }, [event?.shot_id])

  const syncPlay = useCallback(() => {
    Object.values(videoRefs.current).forEach(v => {
      if (v && !errored[v.dataset.cam]) {
        v.currentTime = 0
        v.play().catch(() => {})
      }
    })
    setPlaying(true)
  }, [errored])

  const syncPause = useCallback(() => {
    Object.values(videoRefs.current).forEach(v => v?.pause())
    setPlaying(false)
  }, [])

  const handleEnded = useCallback(() => {
    if (looping) {
      Object.values(videoRefs.current).forEach(v => {
        if (v) { v.currentTime = 0; v.play().catch(() => {}) }
      })
    } else {
      setPlaying(false)
    }
  }, [looping])

  if (!event) return null

  const hasCoords = event.bounce_coords?.x != null

  return (
    <div style={{
      position:    'absolute',
      left:         0, right: 0, bottom: 0,
      background:  'linear-gradient(to top, rgba(9,11,15,0.99) 0%, rgba(14,17,23,0.97) 100%)',
      borderTop:   '1px solid rgba(245,166,35,0.2)',
      boxShadow:   '0 -16px 60px rgba(0,0,0,0.9)',
      animation:   'slideUp 0.25s cubic-bezier(0.22,0.61,0.36,1)',
      zIndex:       40,
      display:     'flex',
      flexDirection: 'column',
      maxHeight:   '52vh',
    }}>

      {/* header with shot info and controls */}
      <div style={{
        display:       'flex',
        alignItems:    'center',
        gap:            12,
        padding:       '10px 16px',
        borderBottom:  '1px solid rgba(255,255,255,0.06)',
        flexShrink:     0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: 'var(--amber)',
            animation: 'pulse 2s ease-in-out infinite',
          }} />
          <span style={{
            fontFamily: 'var(--condensed)', fontSize: 13,
            fontWeight: 600, letterSpacing: '0.15em',
            textTransform: 'uppercase', color: 'var(--amber)',
          }}>
            Shot {event.shot_id}
          </span>
        </div>

        {/* prev/next navigation */}
        <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
          <button onClick={onPrev} style={hdrBtnStyle} title="Previous event">‹ Prev</button>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 10,
            color: 'var(--muted2)', padding: '0 6px',
            alignSelf: 'center',
          }}>
            {eventIndex + 1} / {totalEvents}
          </span>
          <button onClick={onNext} style={hdrBtnStyle} title="Next event">Next ›</button>
        </div>

        {/* play/pause and loop */}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button
            onClick={playing ? syncPause : syncPlay}
            style={{
              ...hdrBtnStyle,
              background: playing ? 'var(--amber)' : 'rgba(245,166,35,0.15)',
              color:       playing ? '#000'         : 'var(--amber)',
              border:      '1px solid rgba(245,166,35,0.3)',
              padding:    '4px 12px',
            }}
          >
            {playing ? '⏸ Pause' : '▶ Play All'}
          </button>
          <button
            onClick={() => setLooping(l => !l)}
            title="Toggle loop"
            style={{
              ...hdrBtnStyle,
              color:       looping ? 'var(--amber)' : 'var(--muted)',
              border:      `1px solid ${looping ? 'rgba(245,166,35,0.3)' : 'rgba(255,255,255,0.08)'}`,
            }}
          >
            ⟳
          </button>
        </div>

        <button
          id="event-panel-close"
          onClick={onClose}
          style={{
            background: 'none', border: 'none',
            color: 'var(--muted)', fontSize: 20,
            cursor: 'pointer', lineHeight: 1,
            padding: '0 4px',
          }}
        >×</button>
      </div>

      {/* the 3 video players + metadata sidebar */}
      <div style={{
        display: 'flex', flex: 1,
        overflow: 'hidden',
        gap: 1,
      }}>

        {CAMERAS.map(cam => {
          const clipFile = event.clips?.[cam]
          const clipUrl  = clipFile ? `${CLIPS_BASE}/${cam}/${clipFile}` : null
          const color    = CAMERA_COLORS[cam]
          const hasErr   = errored[cam]

          return (
            <div key={cam} style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              background: 'rgba(0,0,0,0.4)',
              position: 'relative',
            }}>
              {/* camera label overlay */}
              <div style={{
                position: 'absolute', top: 8, left: 8, zIndex: 2,
                fontFamily: 'var(--condensed)',
                fontSize: 10, fontWeight: 600,
                letterSpacing: '0.15em', textTransform: 'uppercase',
                color: color,
                background: 'rgba(0,0,0,0.7)',
                padding: '2px 7px', borderRadius: 3,
                border: `1px solid ${color}33`,
              }}>
                {CAMERA_LABELS[cam]}
              </div>

              {/* video or fallback if clip is missing */}
              {clipUrl && !hasErr ? (
                <video
                  ref={el => {
                    if (el) {
                      el.dataset.cam = cam
                      videoRefs.current[cam] = el
                    }
                  }}
                  src={clipUrl}
                  muted={false}
                  loop={false}
                  playsInline
                  onEnded={handleEnded}
                  onError={() => setErrored(e => ({ ...e, [cam]: true }))}
                  style={{
                    width: '100%', height: '100%',
                    objectFit: 'contain',
                    display: 'block',
                    minHeight: 0,
                  }}
                />
              ) : (
                <div style={{
                  flex: 1, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', gap: 8,
                  color: 'var(--muted2)',
                }}>
                  <span style={{ fontSize: 28, opacity: 0.4 }}>📷</span>
                  <span style={{
                    fontFamily: 'var(--condensed)', fontSize: 11,
                    letterSpacing: '0.1em', textTransform: 'uppercase',
                    opacity: 0.5,
                  }}>
                    {hasErr ? 'Load error' : 'No clip'}
                  </span>
                </div>
              )}
            </div>
          )
        })}

        {/* metadata sidebar */}
        <div style={{
          width: 160, flexShrink: 0,
          background: 'rgba(14,17,23,0.95)',
          borderLeft: '1px solid rgba(255,255,255,0.06)',
          overflowY: 'auto',
          padding: '12px 14px',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>
          <MetaRow label="Shot ID"     value={event.shot_id} />
          <MetaRow label="Flight ID"   value={event.flight_id} />
          {hasCoords && (
            <>
              <MetaRow label="Bounce X" value={event.bounce_coords.x?.toFixed(2)} unit="m" />
              <MetaRow label="Bounce Y" value={event.bounce_coords.y?.toFixed(2)} unit="m" />
              {event.bounce_coords.z != null && event.bounce_coords.z !== 0 && (
                <MetaRow label="Bounce Z" value={event.bounce_coords.z?.toFixed(3)} unit="m" />
              )}
            </>
          )}
          {event.landing_confidence != null && (
            <MetaRow label="Confidence" value={`${(event.landing_confidence * 100).toFixed(0)}%`} />
          )}
          <MetaRow label="Bounce frame" value={event.bounce_frame} />
          <MetaRow label="HQ frame"     value={event.bounce_hq_frame} />

          {/* which clips are available */}
          <div>
            <div style={{ fontSize: 9, color: 'var(--muted2)', fontFamily: 'var(--condensed)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>Clips</div>
            {CAMERAS.map(cam => (
              <div key={cam} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <div style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: event.clips?.[cam] ? CAMERA_COLORS[cam] : 'var(--muted2)',
                }} />
                <span style={{ fontFamily: 'var(--condensed)', fontSize: 10, color: event.clips?.[cam] ? 'var(--text)' : 'var(--muted2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {CAMERA_LABELS[cam]}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function MetaRow({ label, value, unit }) {
  if (value == null) return null
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--muted2)', fontFamily: 'var(--condensed)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)' }}>
        {value}{unit ? <span style={{ color: 'var(--muted)', marginLeft: 2 }}>{unit}</span> : null}
      </div>
    </div>
  )
}

const hdrBtnStyle = {
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 3,
  color: 'var(--muted)',
  fontSize: 11,
  cursor: 'pointer',
  padding: '3px 8px',
  fontFamily: 'var(--condensed)',
  letterSpacing: '0.08em',
  transition: 'all 0.12s',
}
