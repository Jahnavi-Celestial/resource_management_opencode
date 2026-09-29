import { useEffect, useRef } from 'react'
import Alert from '@mui/material/Alert'

/**
 * A page-level notice that goes away on its own.
 *
 * Every screen used to hand-roll the same `Alert` with a manual `onClose`, and
 * the message stayed until the next one replaced it or the user pressed the
 * cross. This is the shared version: it closes itself after `durationMs`, and
 * the cross still works for the user who has read it already.
 *
 * Two things about the timer are load-bearing, both found by getting them
 * wrong:
 *
 * - `onClose` is held in a **ref**, so the effect does not depend on it. A
 *   screen re-renders when its list refetches after a write, and an inline
 *   `() => setNotice(null)` is a new identity every render — an effect keyed on
 *   it would restart the timer on every refetch and the banner would live far
 *   longer than the duration.
 * - The timer is keyed on `resetKey`, not on the children's identity. A new
 *   message restarts the duration (the user has not read *this* one yet), while
 *   JSX children are a fresh object every render and would restart it forever.
 *   Screens pass a stable primitive — the message string, a booking id.
 */
export interface NoticeProps {
  severity: 'success' | 'error'
  /** Called when the timer fires. The screen clears its state and this unmounts. */
  onClose: () => void
  /** How long the notice stays, in milliseconds. */
  durationMs?: number
  /**
   * A stable primitive identifying the current message. A new value restarts
   * the duration; the same value across a re-render does not.
   */
  resetKey: string | number
  testid?: string
  children: React.ReactNode
}

export const DEFAULT_NOTICE_DURATION_MS = 5000

export function Notice({
  severity,
  onClose,
  durationMs = DEFAULT_NOTICE_DURATION_MS,
  resetKey,
  testid,
  children,
}: NoticeProps): React.ReactElement {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const timer = setTimeout(() => onCloseRef.current(), durationMs)
    return () => clearTimeout(timer)
  }, [durationMs, resetKey])

  return (
    <Alert severity={severity} onClose={onClose} sx={{ mb: 2 }} data-testid={testid}>
      {children}
    </Alert>
  )
}
