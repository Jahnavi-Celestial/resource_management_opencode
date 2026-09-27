import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { useAuth } from './AuthProvider'
import { hasAll, hasAny, type PermissionKey } from './permissions'

export interface RequirePermissionProps {
  keys: readonly PermissionKey[]
  /** 'any' (default) or 'all' — the same rule `nav-items.ts` applies. */
  mode?: 'all' | 'any'
  children: ReactNode
}

/**
 * The route guard. Three states, in this order:
 *   1. still loading the session  → spinner (never flash the login page at a
 *      signed-in user whose `me` is still in flight);
 *   2. no session                 → redirect to /login, keeping the attempted
 *      path in `state.from` so login can return there;
 *   3. session without the keys   → a refusal, and `children` is never mounted.
 */
export function RequirePermission({ keys, mode = 'any', children }: RequirePermissionProps): ReactNode {
  const { status, permissions } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }} data-testid="guard-loading">
        <CircularProgress size={28} />
      </Box>
    )
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  const allowed = mode === 'any' ? hasAny(permissions, keys) : hasAll(permissions, keys)
  if (!allowed) {
    return (
      <Box sx={{ p: 3 }} data-testid="guard-denied">
        <Alert severity="error" data-testid="guard-denied-alert">
          <Typography variant="h3" component="h2" gutterBottom>
            Not authorised
          </Typography>
          <Typography variant="body2">
            Your account does not have access to this page. If you think that is
            wrong, ask an administrator to review your roles.
          </Typography>
        </Alert>
      </Box>
    )
  }

  return <>{children}</>
}
