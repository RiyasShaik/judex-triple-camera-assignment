/* LiveBadge.jsx - the LIVE indicator button */
export default function LiveBadge({ isLive, isPaused, onClick }) {
  return (
    <button
      id="live-badge-btn"
      onClick={onClick}
      title={isLive ? 'At live edge' : 'Jump to live'}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        background: isLive && !isPaused ? 'var(--red)' : 'rgba(255,48,48,0.18)',
        border: `1px solid ${isLive && !isPaused ? 'var(--red)' : 'rgba(255,48,48,0.4)'}`,
        borderRadius: 3, padding: '3px 8px',
        cursor: isLive ? 'default' : 'pointer',
        fontFamily: 'var(--condensed)', fontSize: 12, fontWeight: 600,
        letterSpacing: '0.12em', color: isLive && !isPaused ? '#fff' : 'rgba(255,80,80,0.9)',
        textTransform: 'uppercase', transition: 'all 0.2s ease',
        flexShrink: 0,
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: isLive && !isPaused ? '#fff' : 'rgba(255,80,80,0.7)',
        animation: isLive && !isPaused ? 'pulse 1.4s ease-in-out infinite' : 'none',
      }} />
      LIVE
    </button>
  )
}
