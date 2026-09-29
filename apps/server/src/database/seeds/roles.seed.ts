import type { DataSource } from 'typeorm'
import { PERMISSION_KEYS, type PermissionKey } from '@resource-booking/shared'
import { Permission } from '../../modules/rbac/permission.entity'
import { Role } from '../../modules/rbac/role.entity'
import { RolePermission } from '../../modules/rbac/role-permission.entity'
import { ADMIN_ROLE_NAME } from '../../modules/rbac/system-roles'

export interface RoleSeed {
  roleName: string
  permissionNames: PermissionKey[]
}

export const ROLE_SEEDS: RoleSeed[] = [
  {
    roleName: ADMIN_ROLE_NAME,
    // Approvals are the Manager's job, not the Admin's: the approval UI, the
    // approve/reject mutations and the BOOKING_PENDING notification recipients
    // are all gated on `booking:approve`, so the Admin role must not hold it
    // (or `booking:reject`). Booking creation is the Employee's job: the admin
    // administrates the catalogue and the people, and a booking of their own
    // could never be decided (FR-56 bars self-decision, and the admin holds no
    // approval permission), so it would stall in PENDING forever. Everything
    // else stays.
    permissionNames: PERMISSION_KEYS.filter(
      (key) =>
        key !== 'booking:approve' && key !== 'booking:reject' && key !== 'booking:create',
    ),
  },
  {
    roleName: 'Manager',
    permissionNames: [
      'booking:read:all',
      'booking:approve',
      'booking:reject',
      'booking:cancel:any',
      'room:read',
      'equipment:read',
      'employee:read',
      'report:read',
    ],
  },
  {
    roleName: 'Employee',
    permissionNames: [
      'booking:create',
      'booking:read:own',
      'booking:cancel:own',
      'room:read',
      'equipment:read',
    ],
  },
]

export async function seedRoles(dataSource: DataSource): Promise<void> {
  const roleRepository = dataSource.getRepository(Role)
  const permissionRepository = dataSource.getRepository(Permission)
  const rolePermissionRepository = dataSource.getRepository(RolePermission)

  const allPermissions = await permissionRepository.find()
  const permissionIdByName = new Map(allPermissions.map((p) => [p.permissionName, p.id]))

  for (const roleSeed of ROLE_SEEDS) {
    const missingPermissionIds = roleSeed.permissionNames
      .map((permissionName) => permissionIdByName.get(permissionName))
      .filter((permissionId): permissionId is string => permissionId !== undefined)
    if (missingPermissionIds.length !== roleSeed.permissionNames.length) {
      throw new Error(
        `role "${roleSeed.roleName}" references permissions missing from the database — run the permissions seed first`,
      )
    }

    let role = await roleRepository.findOne({ where: { roleName: roleSeed.roleName } })
    const roleCreated = role === null
    if (role === null) {
      role = await roleRepository.save({ roleName: roleSeed.roleName } as Role)
    }

    const existingLinks = await rolePermissionRepository.find({ where: { roleId: role.id } })
    const existingPermissionIds = new Set(existingLinks.map((link) => link.permissionId))
    const seededPermissionIds = new Set(missingPermissionIds)
    const linksToInsert = missingPermissionIds
      .filter((permissionId) => !existingPermissionIds.has(permissionId))
      .map((permissionId) => ({ roleId: role.id, permissionId }))

    if (linksToInsert.length > 0) {
      await rolePermissionRepository.createQueryBuilder().insert().values(linksToInsert).orIgnore().execute()
    }

    // Sync, not add-only: a permission removed from the seed (e.g. the Admin
    // role no longer holding `booking:approve`) must actually be revoked from
    // an existing role, or the next `npm run seed` silently keeps the old grant.
    const staleLinks = existingLinks.filter((link) => !seededPermissionIds.has(link.permissionId))
    if (staleLinks.length > 0) {
      await rolePermissionRepository
        .createQueryBuilder()
        .delete()
        .where('role_id = :roleId', { roleId: role.id })
        .andWhere('permission_id IN (:...stalePermissionIds)', {
          stalePermissionIds: staleLinks.map((link) => link.permissionId),
        })
        .execute()
    }

    console.log(
      `role "${roleSeed.roleName}": ${roleCreated ? 'created' : 'already present'}, permission links added ${linksToInsert.length} of ${roleSeed.permissionNames.length}, removed ${staleLinks.length}`,
    )
  }
}
