import DataLoader from 'dataloader'
import type { DataSource } from 'typeorm'
import { Permission } from '../modules/rbac/permission.entity'
import { RolePermission } from '../modules/rbac/role-permission.entity'

export function createRolePermissionsLoader(dataSource: DataSource): DataLoader<string, Permission[]> {
  return new DataLoader<string, Permission[]>(async (roleIds: readonly string[]) => {
    const rolePermissions = await dataSource
      .getRepository(RolePermission)
      .createQueryBuilder('rolePermission')
      .innerJoinAndSelect('rolePermission.permission', 'permission')
      .where('rolePermission.roleId IN (:...roleIds)', { roleIds: [...roleIds] })
      .orderBy('permission.permissionName', 'ASC')
      .getMany()
    const permissionsByRoleId = new Map<string, Permission[]>()
    for (const rolePermission of rolePermissions) {
      const bucket = permissionsByRoleId.get(rolePermission.roleId)
      if (bucket === undefined) {
        permissionsByRoleId.set(rolePermission.roleId, [rolePermission.permission])
      } else {
        bucket.push(rolePermission.permission)
      }
    }
    return roleIds.map((roleId) => permissionsByRoleId.get(roleId) ?? [])
  })
}
