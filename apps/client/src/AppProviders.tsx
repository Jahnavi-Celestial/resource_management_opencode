import { useMemo } from 'react'
import { ApolloProvider } from '@apollo/client/react'
import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import { BrowserRouter, MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '@/auth/AuthProvider'
import { RealtimeNotifications } from '@/realtime/useNotificationSocket'
import { theme } from '@/theme'
import type { ReactNode } from 'react'
import type { ApolloClient } from '@apollo/client'

function Router({
  initialEntries,
  children,
}: {
  initialEntries: string[] | undefined
  children: ReactNode
}): ReactNode {
  if (initialEntries !== undefined) {
    return <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
  }
  return <BrowserRouter>{children}</BrowserRouter>
}

export interface AppProvidersProps {
  client: ApolloClient
  /** Provided by tests to mount at a route; the app itself uses the browser. */
  initialEntries?: string[]
  /**
   * The notification socket is off by default in the acceptance harnesses
   * because they run against jsdom's `WebSocket`, which is implemented by
   * `undici` and has a broken `dispatchEvent` that throws on every
   * `onopen`/`onmessage` call — a defect in the test environment, not in
   * the socket, and one the C3 harness will opt back in to exercise.
   */
  realtime?: boolean
}

/**
 * The provider stack, in one place and used by both `main.tsx` and the C0
 * acceptance suite, so the thing under test is the app that ships: MUI's
 * `ThemeProvider` really does wrap the router and the auth context.
 *
 * `RealtimeNotifications` sits inside `AuthProvider` because that is the only
 * place a session is known — it is the single mount point for the notification
 * socket, and the component itself renders nothing. It is here rather than in
 * `main.tsx` for the same reason the rest of the stack is: the app under test
 * is the app that ships.
 */
export function AppProviders({
  client,
  initialEntries,
  realtime = true,
  children,
}: AppProvidersProps & { children: ReactNode }): ReactNode {
  const memoInitialEntries = useMemo(() => initialEntries, [initialEntries])
  return (
    <ApolloProvider client={client}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Router initialEntries={memoInitialEntries}>
          <AuthProvider>
            {realtime && <RealtimeNotifications />}
            {children}
          </AuthProvider>
        </Router>
      </ThemeProvider>
    </ApolloProvider>
  )
}
