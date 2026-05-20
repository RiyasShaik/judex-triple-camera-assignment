/*
 * useEvents.js
 * Fetches shot events from the backend and provides helpers
 * for navigating between them (prev/next, find nearest etc.)
 */
import { useState, useEffect, useCallback } from 'react'

const API_BASE = 'http://localhost:8080'

export default function useEvents() {
  const [events,         setEvents]         = useState([])
  const [loading,        setLoading]        = useState(true)
  const [activeEventIdx, setActiveEventIdx] = useState(null)

  useEffect(() => {
    fetch(`${API_BASE}/events`)
      .then(r => r.json())
      .then(data => {
        setEvents(data.events ?? [])
        setLoading(false)
      })
      .catch(err => {
        console.warn('[events] failed to fetch:', err)
        setLoading(false)
      })
  }, [])

  // find the event closest to a given time
  const findNearestEvent = useCallback((camera, timestamp) => {
    let best = null, bestDelta = Infinity
    events.forEach((ev, i) => {
      const ts = ev.timestamps?.[camera]
      if (ts == null) return
      const d = Math.abs(ts - timestamp)
      if (d < bestDelta) { bestDelta = d; best = i }
    })
    return best
  }, [events])

  // find the latest event before current time
  const goPrevEvent = useCallback((camera, currentTime) => {
    let best = null
    events.forEach((ev, i) => {
      const ts = ev.timestamps?.[camera]
      if (ts != null && ts < currentTime - 0.5) best = i
    })
    return best
  }, [events])

  // find the first event after current time
  const goNextEvent = useCallback((camera, currentTime) => {
    for (let i = 0; i < events.length; i++) {
      const ts = events[i].timestamps?.[camera]
      if (ts != null && ts > currentTime + 0.5) return i
    }
    return null
  }, [events])

  return {
    events, loading,
    activeEventIdx, setActiveEventIdx,
    findNearestEvent, goPrevEvent, goNextEvent,
  }
}
