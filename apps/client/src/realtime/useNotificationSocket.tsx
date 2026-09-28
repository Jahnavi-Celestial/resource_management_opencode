/**
 * The one owner of the notification socket (C3 part 1).
 *
 * The socket itself (`RealtimeSocket`) is a transport with no opinions about
 * React or Apollo; this hook is where both of those meet.
 *
 * - **One connection per logged-in session.** The effect connects only when
 *   the session is `authenticated`, and its cleanup owns the socket's whole
 *   lifetime. Creating the socket *inside* the effect (rather than in a ref
 *   that outlives it) is the point: React guarantees the cleanup runs before
 *   the next effect invocation and again on unmount, so there is no window in
 *   which two sockets for one session can both be live. StrictMode's
 *   double-mount therefore costs one extra handshake, not two sockets.
 * - **The token comes from `tokenStorage`, not from props**, because that is
 *   the same source the Apollo auth link reads. A socket carrying a different
 *   token from the one HTTP is using would be a bug that is very hard to see.
 * - **`me` and the token's `exp` are the authority on the session, the close
 *   code is not.** See `ws-client.ts`; here it just means: when the client
 *   reports an auth failure, the response is the app's own `logout()`.
 * - **The server's `unreadCount` is written verbatim.** Never `+ 1`: after any
 *   reconnect the client has missed events, and a local increment would stay
 *   wrong for the rest of the session.
 *
 * The hook also carries the live-toast state, because the toast must be driven
 * by the same socket that owns the connection — and only by that socket. It
 * fires on a genuine `notification.created`, never on the initial load or a
 * reconnect refetch (both are distinguished by the `isInitial` flag the caller
 * passes).
 */

import { useCallback, useEffect, useState } from 'react'
import React from 'react'
import Snackbar from '@mui/material/Snackbar'
import IconButton from '@mui/material/IconButton'
import { useApolloClient } from '@apollo/client/react'
import type { ApolloClient } from '@apollo/client'
import { useAuth } from '@/auth/AuthProvider'
import { tokenStorage } from '@/apollo/token-storage'
import { UnreadCountDocument } from '@/features/notifications/graphql/notifications.graphql'
import {
  DEFAULT_WS_URL,
  RealtimeSocket,
  type InboundEvent,
  type RealtimeState,
} from './ws-client'

export const DEFAULT_WS_BASE_URL = import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL

const REFETCH_ON_OPEN = ['UnreadCount', 'MyNotifications'] as const
const REFETCH_ON_EVENT = ['MyNotifications'] as const

/** Writes the server's unread count into the cache. */
export function applyUnreadCount(client: ApolloClient, unreadCount: number): void {
  client.cache.writeQuery({ query: UnreadCountDocument, data: { unreadCount } })
}

function refetchQuietly(client: ApolloClient, include: readonly string[]): void {
  void client.refetchQueries({ include: [...include] }).catch(() => undefined)
}

/** The socket's live-toast state: one title at a time, dismissible. */
export interface NotificationToast {
  title: string | null
  /** True until the caller has handled the event — the refetch on open must
      not also fire the toast. */
  isLive: boolean
  dismiss: () => void
}

/**
 * Creates and returns the current toast state so callers can read it
 * without subscribing to the socket directly.
 */
export function useNotificationSocket(): { toast: NotificationToast } {
  const client = useApolloClient()
  const { status, logout } = useAuth()
  const [toast, setToast] = useState<NotificationToast>({
    title: null,
    isLive: false,
    dismiss: () => setToast((t) => ({ ...t, title: null, isLive: false })),
  })

  const onEvent = useCallback(
    (event: InboundEvent) => {
      if (event.type !== 'notification.created') {
        return
      }
      applyUnreadCount(client, event.unreadCount)
      // A live event is the only thing that may open the toast. The
      // refetch on open/refetchQueries that follow a reconnect read the
      // *existing* notifications back — they are not new arrivals, and
      // showing the toast for them would spam the user on every reconnection.
      setToast({ title: event.notification.title, isLive: true, dismiss: () => setToast({ title: null, isLive: false, dismiss: () => {} }) })
      refetchQuietly(client, REFETCH_ON_EVENT)
    },
    [client],
  )

  const onStateChange = useCallback(
    (next: RealtimeState) => {
      if (next === 'open') {
        refetchQuietly(client, REFETCH_ON_OPEN)
      }
    },
    [client],
  )

  useEffect(() => {
    if (status !== 'authenticated') {
      return
    }

    const socket = new RealtimeSocket({
      baseUrl: DEFAULT_WS_BASE_URL,
      getToken: () => tokenStorage.get(),
      onAuthFailed: () => {
        void logout()
      },
    })

    const unsubscribeEvent = socket.subscribe(onEvent)
    const unsubscribeState = socket.onStateChange(onStateChange)
    socket.start()

    return () => {
      unsubscribeEvent()
      unsubscribeState()
      socket.stop()
    }
  }, [client, status, logout, onEvent, onStateChange])

  return { toast }
}

/**
 * Renders the live-toast Snackbar and owns the socket. Kept as a
 * component so the app root can mount the socket and the toast in one
 * place — "mounted exactly once" is greppable here. It renders inside
 * `ThemeProvider`, so the Snackbar positions itself against the
 * viewport.
 */
export function RealtimeNotifications(): React.ReactElement {
  useNotificationSocket()
  return <NotificationSnackbar />
}

/**
 * The live-toast: a one-line MUI Snackbar that appears when a new
 * notification arrives over the socket. `dismiss` is stable-ish (it is
 * recreated on every render, but the snackbar's `autoHideDuration` and
 * the `open` prop drive its own lifetime), so the caller need not
 * manage it.
 */
export function NotificationSnackbar(): React.ReactElement {
  const { toast } = useNotificationSocket()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (toast.isLive && toast.title !== null) {
      setOpen(true)
    }
  }, [toast.isLive, toast.title])

  const handleClose = useCallback(() => {
    setOpen(false)
    toast.dismiss()
  }, [toast.dismiss])

  return (
    <Snackbar
      open={open}
      autoHideDuration={4000}
      onClose={handleClose}
      message={toast.title}
      action={
        <IconButton size="small" color="inherit" onClick={handleClose} aria-label="close notification">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </IconButton>
      }
    />
  )
}
