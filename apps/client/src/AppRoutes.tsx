import Alert from '@mui/material/Alert'
import Typography from '@mui/material/Typography'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { RequirePermission } from '@/auth/RequirePermission'
import { AppShell } from '@/components/layout/AppShell'
import { firstPermittedPath, NAV_ITEMS } from '@/components/layout/nav-items'
import { PlaceholderPage } from '@/components/layout/PlaceholderPage'
import { LoginPage } from '@/features/auth/pages/LoginPage'

/** Sends `/` to the first screen this session is allowed to open. */
function Home(): React.ReactNode {
  const { permissions } = useAuth()
  const target = firstPermittedPath(permissions)
  if (target !== null) {
    return <Navigate to={target} replace />
  }
  return (
    <Alert severity="warning" data-testid="no-permissions">
      <Typography variant="h3" component="h2" gutterBottom>
        Nothing to show yet
      </Typography>
      <Typography variant="body2">
        Your account has no roles assigned, so there is nothing to open. Ask an
        administrator to assign one.
      </Typography>
    </Alert>
  )
}

function NotFound(): React.ReactNode {
  return (
    <Alert severity="info" data-testid="not-found">
      <Typography variant="body2">This page does not exist.</Typography>
    </Alert>
  )
}

export function AppRoutes(): React.ReactNode {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* An empty key list is the "any signed-in user" guard: it still sends an
          anonymous visitor to /login and still waits for the session. */}
      <Route
        element={
          <RequirePermission keys={[]}>
            <AppShell />
          </RequirePermission>
        }
      >
        <Route path="/" element={<Home />} />
        {NAV_ITEMS.map((item) => (
          <Route
            key={item.path}
            path={item.path}
            element={
              <RequirePermission keys={item.keys} mode={item.mode ?? 'any'}>
                <PlaceholderPage item={item} />
              </RequirePermission>
            }
          />
        ))}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
