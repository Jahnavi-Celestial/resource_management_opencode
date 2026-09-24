import type { EntityManager } from 'typeorm'
import { LockoutGuardError } from '../../common/errors/lockout-guard-error'
import { Permission } from './permission.entity'
import { Role } from './role.entity'
import { RolePermission } from './role-permission.entity'
import { UserRole } from './user-role.entity'

const ROLE_ASSIGN = 'role:assign'

async function lockRoleAssignHolders(em: EntityManager): Promise<void> {
  await em
    .getRepository(Role)
    .createQueryBuilder('role')
    .select('role.id', 'roleId')
    .innerJoin(RolePermission, 'rolePermission', 'rolePermission.role_id = role.id')
    .innerJoin(Permission, 'permission', 'permission.id = rolePermission.permission_id')
    .where('permission.permission_name = :permissionName', { permissionName: ROLE_ASSIGN })
    .orderBy('role.id')
    .setLock('pessimistic_write')
    .getRawMany()
}

async function roleIdsHoldingRoleAssign(em: EntityManager): Promise<Set<string>> {
  const rows = await em
    .getRepository(Role)
    .createQueryBuilder('role')
    .select('role.id', 'roleId')
    .innerJoin(RolePermission, 'rolePermission', 'rolePermission.role_id = role.id')
    .innerJoin(Permission, 'permission', 'permission.id = rolePermission.permission_id')
    .where('permission.permission_name = :permissionName', { permissionName: ROLE_ASSIGN })
    .getRawMany<{ roleId: string }>()
  return new Set(rows.map((row) => row.roleId))
}

async function countOtherRoleAssignHolders(
  em: EntityManager,
  employeeId: string,
  roleId: string,
): Promise<number> {
  const row = await em
    .getRepository(UserRole)
    .createQueryBuilder('userRole')
    .select('COUNT(DISTINCT userRole.employee_id)', 'holderCount')
    .innerJoin(RolePermission, 'rolePermission', 'rolePermission.role_id = userRole.role_id')
    .innerJoin(Permission, 'permission', 'permission.id = rolePermission.permission_id')
    .where('permission.permission_name = :permissionName', { permissionName: ROLE_ASSIGN })
    .andWhere('NOT (userRole.employee_id = :employeeId AND userRole.role_id = :roleId)', {
      employeeId,
      roleId,
    })
    .getRawOne<{ holderCount: string }>()
  const holderCount = row?.holderCount
  return holderCount === undefined ? 0 : Number.parseInt(holderCount, 10)
}

export async function assertRoleDeletable(em: EntityManager, role: Role): Promise<void> {
  await lockRoleAssignHolders(em)
  const holders = await roleIdsHoldingRoleAssign(em)
  if (holders.has(role.id) && holders.size === 1) {
    throw new LockoutGuardError(
      `Cannot delete role "${role.roleName}" because it is the last role holding the '${ROLE_ASSIGN}' permission. Assign '${ROLE_ASSIGN}' to another role first.`,
    )
  }
}

export async function assertPermissionRemovable(
  em: EntityManager,
  role: Role,
  permission: Permission,
): Promise<void> {
  if (permission.permissionName !== ROLE_ASSIGN) return
  await lockRoleAssignHolders(em)
  const holders = await roleIdsHoldingRoleAssign(em)
  if (holders.has(role.id) && holders.size === 1) {
    throw new LockoutGuardError(
      `Cannot remove '${ROLE_ASSIGN}' from role "${role.roleName}" because it is the last role holding that permission. The system would be locked out of role administration.`,
    )
  }
}

export async function assertRoleRemovableFromEmployee(
  em: EntityManager,
  employeeId: string,
  role: Role,
): Promise<void> {
  await lockRoleAssignHolders(em)
  const holders = await roleIdsHoldingRoleAssign(em)
  if (!holders.has(role.id)) return
  const otherHolders = await countOtherRoleAssignHolders(em, employeeId, role.id)
  if (otherHolders === 0) {
    throw new LockoutGuardError(
      `Cannot remove role "${role.roleName}" from this employee because it is the last assignment of a role holding '${ROLE_ASSIGN}'. The system would be locked out of role administration.`,
    )
  }
}
