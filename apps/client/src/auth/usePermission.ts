import { useAuth } from './AuthProvider'
import { hasAll, hasAny, type PermissionKey } from './permissions'

/**
 * NFR-5: this is a usability affordance only. The server re-checks every
 * operation's permissions (authChecker), so hiding a nav item or a route is
 * about not offering an action the user cannot take — never about security.
 */
export function usePermission(...keys: PermissionKey[]): boolean {
  const { permissions } = useAuth()
  return hasAll(permissions, keys)
}

/** Same, for the "own or all" style screens (e.g. `booking:read:*`). */
export function useAnyPermission(...keys: PermissionKey[]): boolean {
  const { permissions } = useAuth()
  return hasAny(permissions, keys)
}
