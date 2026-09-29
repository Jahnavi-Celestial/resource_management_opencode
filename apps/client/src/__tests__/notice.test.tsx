import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Notice } from '@/components/Notice'

/**
 * The auto-dismiss contract of the shared `Notice`: a page-level banner that
 * goes away on its own after 5 seconds, while the cross still works for the
 * user who has read it already.
 *
 * The two cases that are easy to get wrong are the ones with a timer and a
 * parent that re-renders:
 *
 * - A screen re-renders when its list refetches after a write. If the timer
 *   were keyed on the `onClose` identity, every refetch would restart it and
 *   the banner would outlive the duration by as long as the user spends on
 *   the page. `onClose` is held in a ref, so a re-render must NOT reset it.
 * - A new message must restart the duration — the user has not read *this* one
 *   yet — which is why the timer keys on `resetKey` and not on mount.
 *
 * Every timer advance is wrapped in `act()`: the close is a setState from a
 * timer callback, and without flushing the re-render the assertion would read
 * a DOM the timer has already logically dismissed.
 */
interface Message {
  key: string
  text: string
}

let setMessage: React.Dispatch<React.SetStateAction<Message | null>> = () => undefined

function Harness({
  durationMs,
  testid,
  message,
  onClose,
}: {
  durationMs?: number
  testid?: string
  message: Message | null
  onClose: () => void
}): React.ReactElement {
  if (message === null) {
    return <div data-testid="gone" />
  }
  return (
    <Notice severity="success" onClose={onClose} durationMs={durationMs} resetKey={message.key} testid={testid}>
      {message.text}
    </Notice>
  )
}

function HarnessWrapper({
  durationMs,
  testid,
}: {
  durationMs?: number
  testid?: string
}): React.ReactElement {
  const [message, setMessageState] = useState<Message | null>({ key: 'a', text: 'Saved.' })
  // Exposed to the tests: the only way to swap the message from outside.
  setMessage = setMessageState
  return (
    <Harness
      durationMs={durationMs}
      testid={testid}
      message={message}
      onClose={() => setMessage(null)}
    />
  )
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function screenNotice(): HTMLElement | null {
  return screen.queryByTestId('notice')
}

describe('Notice', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes itself after the default 5 seconds', () => {
    render(<HarnessWrapper testid="notice" />)
    expect(screenNotice()).not.toBeNull()

    advance(4999)
    expect(screenNotice()).not.toBeNull()
    advance(1)
    expect(screenNotice()).toBeNull()
    expect(screen.getByTestId('gone')).toBeInTheDocument()
  })

  it('honours a custom duration', () => {
    render(<HarnessWrapper durationMs={1500} testid="notice" />)

    advance(1499)
    expect(screenNotice()).not.toBeNull()
    advance(1)
    expect(screenNotice()).toBeNull()
  })

  it('a parent re-render does not restart the timer', () => {
    const utils = render(<HarnessWrapper testid="notice" />)

    advance(4000)
    // The screen refetches its list after a write; the banner must not notice.
    utils.rerender(<HarnessWrapper testid="notice" />)
    advance(4000)
    // 8s since the message, 4s since the re-render: gone only if the timer was
    // never restarted (a restart would fire at 4s + 5s = 9s).
    expect(screenNotice()).toBeNull()
  })

  it('a new message restarts the duration', () => {
    render(<HarnessWrapper testid="notice" />)

    advance(4000)
    act(() => {
      setMessage({ key: 'b', text: 'Second.' })
    })
    advance(4000)
    // 8s since the first message but only 4s since the second: still here
    // only because the new message restarted the duration.
    expect(screenNotice()).not.toBeNull()
    expect(screenNotice()).toHaveTextContent('Second.')
    advance(1000)
    expect(screenNotice()).toBeNull()
  })

  it('the cross closes it immediately and clears the timer', () => {
    render(<HarnessWrapper testid="notice" />)

    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(screenNotice()).toBeNull()
    expect(screen.getByTestId('gone')).toBeInTheDocument()

    // The timer must be gone with it: advancing well past the duration must
    // not close anything twice.
    advance(10_000)
    expect(screen.getByTestId('gone')).toBeInTheDocument()
  })
})
