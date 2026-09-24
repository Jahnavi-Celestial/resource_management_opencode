import type { DataSource } from 'typeorm'
import { PERMISSION_KEYS, type PermissionKey } from '@resource-booking/shared'
import { Permission } from '../../modules/rbac/permission.entity'
import { Role } from '../../modules/rbac/role.entity'
import { RolePermission } from '../../modules/rbac/role-permission.entity'

export const ADMIN_ROLE_NAME = 'Admin'

export interface RoleSeed {
  roleName: string
  permissionNames: PermissionKey[]
}

export const ROLE_SEEDS: RoleSeed[] = [
  {
    roleName: ADMIN_ROLE_NAME,
    permissionNames: [...PERMISSION_KEYS],
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
    const linksToInsert = missingPermissionIds
      .filter((permissionId) => !existingPermissionIds.has(permissionId))
      .map((permissionId) => ({ roleId: role.id, permissionId }))

    if (linksToInsert.length > 0) {
      await rolePermissionRepository.createQueryBuilder().insert().values(linksToInsert).orIgnore().execute()
    }

    console.log(
      `role "${roleSeed.roleName}": ${roleCreated ? 'created' : 'already present'}, permission links added ${linksToInsert.length} of ${roleSeed.permissionNames.length}`,
    )
  }
}
