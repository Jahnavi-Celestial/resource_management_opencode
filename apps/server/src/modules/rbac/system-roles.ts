/**
 * The roles the system cannot run without. They are seeded by
 * `database/seeds/roles.seed.ts` and referenced by exact name in several
 * acceptance suites and by the client's employee form, so they are protected
 * from deletion and from renaming (see `system-role-guard.ts`).
 *
 * This module owns the names so the domain layer does not reach into the seed
 * scripts; the seeds import them from here.
 */
export const ADMIN_ROLE_NAME = 'Admin'

export const SYSTEM_ROLE_NAMES: readonly string[] = [ADMIN_ROLE_NAME, 'Manager', 'Employee']

/**
 * Case-folded, matching the `LOWER(role_name)` unique index from migration
 * 1790176946849: a row named `admin` is the same role as `Admin` and must be
 * recognised as protected.
 */
export function isSystemRoleName(roleName: string): boolean {
  const folded = roleName.trim().toLowerCase()
  return SYSTEM_ROLE_NAMES.some((name) => name.toLowerCase() === folded)
}
