import type { PermissionKey } from '@resource-booking/shared'

export type { PermissionKey }

export type PermissionSet = ReadonlySet<string>

export function toPermissionSet(keys: readonly string[] | null | undefined): PermissionSet {
  return new Set(keys ?? [])
}

/**
 * All of `keys` granted.
 *
 * An empty list is treated as "no requirement" (allowed) in both helpers, so
 * `keys={[]}` is the guard for "any signed-in user" — it still waits for the
 * session and still redirects an anonymous visitor to the login page.
 */
export function hasAll(granted: PermissionSet, keys: readonly PermissionKey[]): boolean {
  return keys.every((key) => granted.has(key))
}

/** At least one of `keys` granted; see `hasAll` for the empty-list rule. */
export function hasAny(granted: PermissionSet, keys: readonly PermissionKey[]): boolean {
  return keys.length === 0 || keys.some((key) => granted.has(key))
}
