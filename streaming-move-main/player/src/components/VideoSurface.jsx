/*
 * VideoSurface.jsx
 * Renders all 3 <video> elements stacked on top of each other.
 * Only the active camera is visible (opacity 1), the rest are hidden
 * but still playing/buffering in the background.
 */
import { CAMERAS, CAMERA_COLORS } from '../hooks/useTripleStream'

export default function VideoSurface({ setVideoRef, activeCamera, streamStatus, mode }) {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000' }}>
      {CAMERAS.map(cam => {
        const active = cam === activeCamera

        return (
          <video
            key={cam}
            ref={el => setVideoRef(cam, el)}
            muted={!active}
            playsInline
            style={{
              position:   'absolute',
              inset:       0,
              width:       '100%',
              height:      '100%',
              objectFit:  'contain',
              opacity:     active ? 1 : 0,
              pointerEvents: active ? 'auto' : 'none',
              transition:  'opacity 0.08s ease',
              display:     'block',
            }}
          />
        )
      })}

      {/* loading spinner when connecting */}
      {streamStatus[activeCamera] === 'connecting' && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
          background: 'rgba(9,11,15,0.92)',
          animation: 'fadeIn 0.3s ease',
        }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{
                width: 7, height: 7, borderRadius: '50%',
                background: CAMERA_COLORS[activeCamera],
                animation: `blink 1.2s ${i * 0.2}s ease-in-out infinite`,
                opacity: 0.3,
              }} />
            ))}
          </div>
          <span style={{
            fontFamily: 'var(--condensed)', letterSpacing: '0.2em',
            fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase',
          }}>
            Connecting · {activeCamera.toUpperCase()}
          </span>
        </div>
      )}

      {/* error screen */}
      {streamStatus[activeCamera] === 'error' && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 12,
          background: 'rgba(9,11,15,0.97)',
        }}>
          <span style={{ fontSize: 28, color: 'var(--red)', opacity: 0.7 }}>✕</span>
          <span style={{
            fontFamily: 'var(--condensed)', fontSize: 13,
            letterSpacing: '0.15em', color: 'var(--red)', textTransform: 'uppercase',
          }}>Stream Error</span>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 11,
            color: 'var(--muted)', maxWidth: 360, textAlign: 'center',
          }}>
            Could not connect to {activeCamera.toUpperCase()} stream.
            Is tri_stream_server.py running?
          </span>
        </div>
      )}

      {/* review mode indicator */}
      {mode === 'review' && (
        <div style={{
          position: 'absolute', top: 16, left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.8)',
          border: '1px solid rgba(245,166,35,0.5)',
          borderRadius: 4, padding: '5px 14px',
          fontFamily: 'var(--condensed)', fontSize: 11,
          letterSpacing: '0.2em', color: 'var(--amber)',
          textTransform: 'uppercase', pointerEvents: 'none',
          animation: 'slideDown 0.2s ease',
        }}>
          ◉ REPLAY MODE · offline
        </div>
      )}
    </div>
  )
}
