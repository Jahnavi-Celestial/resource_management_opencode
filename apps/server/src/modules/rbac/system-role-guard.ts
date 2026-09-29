import { SystemRoleError } from '../../common/errors/system-role-error'
import { isSystemRoleName } from './system-roles'
import { Role } from './role.entity'

/**
 * The seeded roles (`Admin`, `Manager`, `Employee`) are load-bearing: the
 * bootstrap admin's own link, the employee form's default role and several
 * acceptance suites all look them up by name. Deleting one would cascade
 * through `user_role` and `role_permission` (`ON DELETE CASCADE`), silently
 * stripping every holder's access, so the row is refused outright.
 *
 * These guards are pure name checks — no query, no lock — because the rule is
 * about the role's identity, not about concurrent state. They run inside the
 * caller's transaction so a refusal rolls the write back with it.
 */
export function assertSystemRoleDeletable(role: Role): void {
  if (isSystemRoleName(role.roleName)) {
    throw new SystemRoleError(`Role "${role.roleName}" is a system role and cannot be deleted.`)
  }
}

export function assertSystemRoleRenamable(role: Role): void {
  if (isSystemRoleName(role.roleName)) {
    throw new SystemRoleError(`Role "${role.roleName}" is a system role and cannot be renamed.`)
  }
}
