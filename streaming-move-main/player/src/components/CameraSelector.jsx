/*
 * CameraSelector.jsx
 * The SOURCE / SINK / HQ tab buttons in the header.
 * Shows a little buffer health bar and status dot for each camera.
 */
import { CAMERAS, CAMERA_LABELS, CAMERA_COLORS } from '../hooks/useTripleStream'

export default function CameraSelector({
  activeCamera,
  onSwitch,
  streamStatus,
  liveSegments,
  mode,
}) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: '0 4px' }}>
      {CAMERAS.map(cam => {
        const active  = cam === activeCamera
        const color   = CAMERA_COLORS[cam]
        const status  = streamStatus[cam]
        const segs    = liveSegments?.[cam]?.length ?? 0
        const health  = Math.min(1, segs / 20)

        return (
          <button
            key={cam}
            id={`camera-tab-${cam}`}
            onClick={() => onSwitch(cam)}
            aria-label={`Switch to ${CAMERA_LABELS[cam]} camera`}
            title={`Switch to ${CAMERA_LABELS[cam]} (${['1','2','3'][CAMERAS.indexOf(cam)]})`}
            style={{
              position:     'relative',
              display:      'flex',
              alignItems:   'center',
              gap:           8,
              padding:      '6px 14px',
              borderRadius:  5,
              border:        `1px solid ${active ? color : 'rgba(255,255,255,0.08)'}`,
              background:    active
                ? `linear-gradient(135deg, ${color}22, ${color}10)`
                : 'rgba(255,255,255,0.03)',
              cursor:        'pointer',
              transition:    'all 0.15s ease',
              overflow:      'hidden',
            }}
          >
            {/* buffer health bar at the bottom of active tab */}
            {active && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0,
                height: 2,
                width:  `${health * 100}%`,
                background: color,
                transition: 'width 0.5s ease',
                borderRadius: '0 2px 0 0',
              }} />
            )}

            {/* status dot */}
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: status === 'playing' ? color
                : status === 'error'   ? 'var(--red)'
                : 'var(--muted2)',
              animation: active && status === 'playing' && mode === 'live'
                ? 'pulse 2s ease-in-out infinite'
                : 'none',
              flexShrink: 0,
            }} />

            {/* camera name */}
            <span style={{
              fontFamily:    'var(--condensed)',
              fontSize:       12,
              fontWeight:     600,
              letterSpacing: '0.15em',
              textTransform: 'uppercase',
              color:          active ? color : 'var(--muted)',
              transition:    'color 0.15s',
            }}>
              {CAMERA_LABELS[cam]}
            </span>

            {/* segment count */}
            {mode === 'live' && segs > 0 && (
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize:    9,
                color:       active ? `${color}99` : 'var(--muted2)',
                marginLeft:  2,
              }}>
                {segs}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
