/*
 * SeekBar.jsx
 * The timeline at the bottom. Shows buffered range, playhead,
 * event markers (like the dots on Hotstar for key moments),
 * hover tooltip, and prev/next buttons.
 */
import { useRef, useCallback, useState } from 'react'
import { CAMERA_COLORS } from '../hooks/useTripleStream'

function toFrac(t, start, end) {
  if (end <= start) return 0
  return Math.max(0, Math.min(1, (t - start) / (end - start)))
}

function fmtOffset(s) {
  if (Math.abs(s) < 1) return '0s'
  const abs = Math.round(Math.abs(s))
  const prefix = s < 0 ? '−' : '+'
  if (abs < 60) return `${prefix}${abs}s`
  const m = Math.floor(abs / 60), sec = abs % 60
  return `${prefix}${m}m${String(sec).padStart(2, '0')}s`
}

function fmtTime(s) {
  if (s == null) return '--:--'
  const m = Math.floor(s / 60), sec = Math.floor(s % 60)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

export default function SeekBar({
  currentTime,
  liveEdge,
  bufferStart,
  bufferedEnd,
  segments,
  events,
  activeCamera,
  activeEventIdx,
  onSeek,
  onPrevEvent,
  onNextEvent,
  onEventClick,
  inReview,
}) {
  const trackRef = useRef(null)
  const dragging = useRef(false)
  const [hoverInfo, setHoverInfo] = useState(null)
  const [hoverEventIdx, setHoverEventIdx] = useState(null)

  const segs      = segments ?? []
  const segsStart = segs.length > 0 ? segs[0].start              : null
  const segsEnd   = segs.length > 0 ? segs[segs.length - 1].end  : null

  const rangeStart = segsStart ?? bufferStart ?? (liveEdge != null ? liveEdge - 120 : 0)
  const rangeEnd   = Math.max(segsEnd ?? -Infinity, liveEdge ?? -Infinity, currentTime)

  const timeAtFrac = useCallback((frac) =>
    rangeStart + frac * (rangeEnd - rangeStart),
  [rangeStart, rangeEnd])

  const seekFromEvent = useCallback((e) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onSeek(timeAtFrac(frac))
  }, [timeAtFrac, onSeek])

  const onMouseDown = (e) => {
    dragging.current = true
    seekFromEvent(e)
    window.addEventListener('mousemove', onDragMove)
    window.addEventListener('mouseup', onDragUp)
  }
  const onDragMove = useCallback((e) => {
    if (dragging.current) seekFromEvent(e)
  }, [seekFromEvent])
  const onDragUp = useCallback(() => {
    dragging.current = false
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', onDragUp)
  }, [onDragMove])

  const handleMouseMove = useCallback((e) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return
    const frac = (e.clientX - rect.left) / rect.width
    const t    = timeAtFrac(frac)
    const behind = liveEdge ? liveEdge - t : null

    // check if we're hovering over an event marker
    let hovEv = null
    events?.forEach((ev, i) => {
      const ts = ev.timestamps?.[activeCamera]
      if (ts == null) return
      const mfrac = toFrac(ts, rangeStart, rangeEnd)
      if (Math.abs(mfrac - Math.max(0, Math.min(1, frac))) < 0.012) hovEv = i
    })
    setHoverEventIdx(hovEv)

    setHoverInfo({
      x:   Math.max(0, Math.min(1, frac)) * 100,
      t,
      behind: behind != null ? fmtOffset(-behind) : null,
      event: hovEv != null ? events[hovEv] : null,
    })
  }, [timeAtFrac, liveEdge, events, activeCamera, rangeStart, rangeEnd])

  const handleMouseLeave = () => { setHoverInfo(null); setHoverEventIdx(null) }

  // arrow keys are handled in App.jsx now (single handler for all keyboard shortcuts)

  const playedFrac   = toFrac(currentTime, rangeStart, rangeEnd)
  const bufferedFrac = toFrac(bufferedEnd ?? currentTime, rangeStart, rangeEnd)
  const behind       = liveEdge && currentTime ? liveEdge - currentTime : null

  // only show event markers that are within the visible range
  const visibleEvents = (events ?? [])
    .map((ev, i) => ({ ev, i }))
    .filter(({ ev }) => {
      const ts = ev.timestamps?.[activeCamera]
      return ts != null && ts >= rangeStart && ts <= rangeEnd
    })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, userSelect: 'none' }}>

      {/* top row with labels and event navigation */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 10, fontFamily: 'var(--condensed)',
        letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)',
      }}>
        <span>DVR · {segs.length} segs buffered</span>

        {/* prev/next event buttons */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button
            id="event-prev-btn"
            onClick={onPrevEvent}
            title="Previous event (←)"
            style={navBtnStyle}
          >‹</button>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted2)', minWidth: 48, textAlign: 'center' }}>
            {activeEventIdx != null ? `EV ${Number(activeEventIdx) + 1}` : 'events'}
          </span>
          <button
            id="event-next-btn"
            onClick={onNextEvent}
            title="Next event (→)"
            style={navBtnStyle}
          >›</button>
        </div>

        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: behind != null && behind > 1 ? 'var(--amber)' : 'var(--red)' }}>
          {behind != null && behind > 1 ? fmtOffset(-behind) : 'LIVE'}
        </span>
      </div>

      {/* the actual timeline track */}
      <div
        ref={trackRef}
        onMouseDown={onMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ position: 'relative', height: 28, cursor: 'col-resize' }}
      >
        {/* background rail */}
        <div style={{
          position: 'absolute', top: '50%', left: 0, right: 0,
          transform: 'translateY(-50%)',
          height: 4, background: 'rgba(255,255,255,0.06)',
          borderRadius: 2, overflow: 'visible',
        }}>
          {/* buffered range */}
          <div style={{
            position: 'absolute', left: 0, height: '100%',
            width: `${bufferedFrac * 100}%`,
            background: 'rgba(245,166,35,0.18)',
            borderRadius: 2,
          }} />
          {/* played range */}
          <div style={{
            position: 'absolute', left: 0, height: '100%',
            width: `${playedFrac * 100}%`,
            background: CAMERA_COLORS[activeCamera] ?? 'var(--amber)',
            borderRadius: 2,
          }} />
        </div>

        {/* segment tick marks */}
        {segs.filter(s => s.start > rangeStart && s.start < rangeEnd).map((seg, i) => (
          <div key={i} style={{
            position: 'absolute',
            left: `${toFrac(seg.start, rangeStart, rangeEnd) * 100}%`,
            top: '50%', transform: 'translate(-0.5px, -50%)',
            width: 1, height: 10,
            background: 'rgba(255,255,255,0.1)',
            pointerEvents: 'none',
          }} />
        ))}

        {/* event markers (the yellow dots) */}
        {visibleEvents.map(({ ev, i }) => {
          const ts   = ev.timestamps[activeCamera]
          const frac = toFrac(ts, rangeStart, rangeEnd)
          const isActive = i === activeEventIdx
          const isHover  = i === hoverEventIdx

          return (
            <div
              key={i}
              onClick={(e) => { e.stopPropagation(); onEventClick?.(i, ev) }}
              title={`Shot ${ev.shot_id} @ ${fmtTime(ts)}`}
              style={{
                position:   'absolute',
                left:       `${frac * 100}%`,
                top:        '50%',
                transform:  'translate(-50%, -50%)',
                width:       isActive || isHover ? 10 : 7,
                height:      isActive || isHover ? 10 : 7,
                borderRadius: '50%',
                background:  isActive ? 'var(--amber)'
                  : isHover ? 'rgba(245,166,35,0.85)'
                  : 'rgba(245,166,35,0.55)',
                border:      isActive ? '2px solid rgba(245,166,35,0.5)' : 'none',
                boxShadow:   isActive ? '0 0 8px rgba(245,166,35,0.6)' : 'none',
                cursor:      'pointer',
                zIndex:       isActive ? 4 : 3,
                transition:  'all 0.12s ease',
                animation:   isActive ? 'markerPop 0.3s ease' : 'none',
              }}
            />
          )
        })}

        {/* playhead thumb */}
        <div style={{
          position: 'absolute',
          left: `${playedFrac * 100}%`,
          top: '50%', transform: 'translate(-50%, -50%)',
          width: 12, height: 12, borderRadius: '50%',
          background: CAMERA_COLORS[activeCamera] ?? 'var(--amber)',
          boxShadow: `0 0 0 3px ${CAMERA_COLORS[activeCamera] ?? 'var(--amber)'}30`,
          zIndex: 5, pointerEvents: 'none',
          transition: 'background 0.15s',
        }} />

        {/* live edge marker (red line on the right) */}
        {!inReview && (
          <div style={{
            position: 'absolute', right: 0, top: '50%',
            transform: 'translateY(-50%)',
            width: 2, height: 16,
            background: 'var(--red)', borderRadius: 1, opacity: 0.8,
            pointerEvents: 'none',
          }} />
        )}

        {/* hover tooltip */}
        {hoverInfo && (
          <div style={{
            position:    'absolute',
            bottom:       24,
            left:        `clamp(0%, ${hoverInfo.x}%, calc(100% - 120px))`,
            transform:   'translateX(-50%)',
            background:  'rgba(14,17,23,0.97)',
            border:      '1px solid rgba(255,255,255,0.1)',
            borderRadius: 4,
            padding:     '5px 10px',
            pointerEvents: 'none',
            zIndex:       10,
            minWidth:     80,
            whiteSpace:  'nowrap',
          }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text)' }}>
              {fmtTime(hoverInfo.t)}
              {hoverInfo.behind && (
                <span style={{ color: 'var(--amber)', marginLeft: 6 }}>{hoverInfo.behind}</span>
              )}
            </div>
            {hoverInfo.event && (
              <div style={{ fontSize: 9, color: 'var(--amber)', marginTop: 2, fontFamily: 'var(--condensed)', letterSpacing: '0.08em' }}>
                ◉ Shot {hoverInfo.event.shot_id}
              </div>
            )}
          </div>
        )}
      </div>

      {/* time labels at the bottom */}
      <div style={{
        position: 'relative', height: 12,
        fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--muted2)',
      }}>
        <span style={{ position: 'absolute', left: 0 }}>{fmtTime(rangeStart)}</span>
        <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>{fmtTime((rangeStart + rangeEnd) / 2)}</span>
        <span style={{ position: 'absolute', right: 0, color: 'var(--red)', opacity: 0.7 }}>EDGE</span>
      </div>
    </div>
  )
}

const navBtnStyle = {
  background:   'rgba(255,255,255,0.05)',
  border:       '1px solid rgba(255,255,255,0.1)',
  borderRadius:  3,
  color:        'var(--muted)',
  fontSize:      14,
  lineHeight:    1,
  cursor:       'pointer',
  padding:      '1px 6px',
  fontFamily:   'var(--condensed)',
  transition:   'all 0.12s',
}
