import { hasAll, hasAny, type PermissionKey } from '@/auth/permissions'

export interface NavItem {
  path: string
  label: string
  /** Permissions that make this screen reachable. */
  keys: readonly PermissionKey[]
  /** 'any' (default) or 'all'. */
  mode?: 'all' | 'any'
}

/**
 * One list, used for both the drawer and the route table, so a nav item and the
 * guard protecting its route cannot drift apart. C1 replaces the placeholder
 * bodies for Employee/Role/Room/Equipment with the real screens; the remaining
 * placeholders keep the same permission wiring.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    path: '/bookings/approvals',
    label: 'Approvals',
    keys: ['booking:approve'],
  },
  {
    path: '/bookings',
    label: 'Bookings',
    // A manager reads every booking, an employee only their own; one screen
    // serves both, so either key is enough.
    keys: ['booking:read:own', 'booking:read:all'],
    mode: 'any',
  },
  { path: '/rooms', label: 'Rooms', keys: ['room:read'] },
  { path: '/equipment', label: 'Equipment', keys: ['equipment:read'] },
  { path: '/employees', label: 'Employees', keys: ['employee:read'] },
  { path: '/roles', label: 'Roles', keys: ['role:read'] },
  { path: '/audit', label: 'Audit log', keys: ['audit:read'] },
  { path: '/reports', label: 'Reports', keys: ['report:read'] },
]

export function isPermitted(item: NavItem, granted: ReadonlySet<string>): boolean {
  return item.mode === 'all' ? hasAll(granted, item.keys) : hasAny(granted, item.keys)
}

export function firstPermittedPath(granted: ReadonlySet<string>): string | null {
  const first = NAV_ITEMS.find((item) => isPermitted(item, granted))
  return first?.path ?? null
}
