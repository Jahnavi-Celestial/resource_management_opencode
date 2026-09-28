import Alert from '@mui/material/Alert'
import Typography from '@mui/material/Typography'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { RequirePermission } from '@/auth/RequirePermission'
import { AppShell } from '@/components/layout/AppShell'
import { firstPermittedPath, NAV_ITEMS, type NavItem } from '@/components/layout/nav-items'
import { PlaceholderPage } from '@/components/layout/PlaceholderPage'
import { LoginPage } from '@/features/auth/pages/LoginPage'
import { NotificationsPage } from '@/features/notifications/pages/NotificationsPage'
import { ApprovalsPage } from '@/features/bookings/pages/ApprovalsPage'
import { BookingDetailPage } from '@/features/bookings/pages/BookingDetailPage'
import { BookingsPage } from '@/features/bookings/pages/BookingsPage'
import { EmployeesPage } from '@/features/employees/pages/EmployeesPage'
import { EquipmentPage } from '@/features/equipment/pages/EquipmentPage'
import { RolesPage } from '@/features/roles/pages/RolesPage'
import { RoomsPage } from '@/features/rooms/pages/RoomsPage'
import { AuditLogPage } from '@/features/audit/pages/AuditLogPage'
import { ReportsPage } from '@/features/reports/pages/ReportsPage'
import type { ReactElement } from 'react'

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

/**
 * C1 replaced four of these with real screens, C2 the bookings list and the
 * manager's approval queue. The map
 * stays the single source of truth: a nav item that is not listed here renders
 * the placeholder behind exactly the same guard, so adding a screen can never
 * widen access.
 */
const REAL_SCREENS: Readonly<Record<string, ReactElement>> = {
  '/notifications': <NotificationsPage />,
  '/employees': <EmployeesPage />,
  '/roles': <RolesPage />,
  '/rooms': <RoomsPage />,
  '/equipment': <EquipmentPage />,
  '/bookings': <BookingsPage />,
  // Guarded by its own nav item's `booking:approve`, because `screenFor` reads
  // the guard from `NAV_ITEMS` — the approvals entry, not the bookings one.
  '/bookings/approvals': <ApprovalsPage />,
  '/audit': <AuditLogPage />,
  '/reports': <ReportsPage />,
}

function screenFor(item: NavItem): React.ReactNode {
  return REAL_SCREENS[item.path] ?? <PlaceholderPage item={item} />
}

/** The `/bookings` nav item, reused as the detail route's guard (see below). */
const BOOKINGS_NAV: NavItem =
  NAV_ITEMS.find((item) => item.path === '/bookings') ??
  // Unreachable while `NAV_ITEMS` holds a `/bookings` entry; an empty key list is
  // the "any signed-in user" guard, so a typo here fails closed on rendering
  // rather than throwing at import.
  { path: '/bookings', label: 'Bookings', keys: [] }

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
                {screenFor(item)}
              </RequirePermission>
            }
          />
        ))}
        {/*
          The booking detail route is a child of the list's, not a nav item of its
          own, so it is declared separately — but it takes its guard *from* that
          nav item rather than repeating the key list, so a session that cannot
          open the list can never deep-link to a booking either.
        */}
        <Route
          path="/bookings/:id"
          element={
            <RequirePermission keys={BOOKINGS_NAV.keys} mode={BOOKINGS_NAV.mode ?? 'any'}>
              <BookingDetailPage />
            </RequirePermission>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
