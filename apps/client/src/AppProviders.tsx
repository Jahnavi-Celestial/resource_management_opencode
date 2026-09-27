import { useMemo } from 'react'
import { ApolloProvider } from '@apollo/client/react'
import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import { BrowserRouter, MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '@/auth/AuthProvider'
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
}

/**
 * The provider stack, in one place and used by both `main.tsx` and the C0
 * acceptance suite, so the thing under test is the app that ships: MUI's
 * `ThemeProvider` really does wrap the router and the auth context.
 */
export function AppProviders({ client, initialEntries, children }: AppProvidersProps & { children: ReactNode }): ReactNode {
  const memoInitialEntries = useMemo(() => initialEntries, [initialEntries])
  return (
    <ApolloProvider client={client}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Router initialEntries={memoInitialEntries}>
          <AuthProvider>{children}</AuthProvider>
        </Router>
      </ThemeProvider>
    </ApolloProvider>
  )
}
