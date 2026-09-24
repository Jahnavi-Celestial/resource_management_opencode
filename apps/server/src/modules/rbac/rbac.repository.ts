import type { EntityManager } from 'typeorm'
import { RolePermission } from './role-permission.entity'
import { UserRole } from './user-role.entity'

export class RbacRepository {
  constructor(private readonly em: EntityManager) {}

  async findRolePermission(roleId: string, permissionId: string): Promise<RolePermission | null> {
    return this.em.getRepository(RolePermission).findOne({ where: { roleId, permissionId } })
  }

  async insertRolePermission(roleId: string, permissionId: string): Promise<void> {
    const link = new RolePermission()
    link.roleId = roleId
    link.permissionId = permissionId
    await this.em.getRepository(RolePermission).save(link)
  }

  async deleteRolePermission(link: RolePermission): Promise<void> {
    await this.em.getRepository(RolePermission).remove(link)
  }

  async findUserRole(employeeId: string, roleId: string): Promise<UserRole | null> {
    return this.em.getRepository(UserRole).findOne({ where: { employeeId, roleId } })
  }

  async insertUserRole(employeeId: string, roleId: string): Promise<void> {
    const link = new UserRole()
    link.employeeId = employeeId
    link.roleId = roleId
    await this.em.getRepository(UserRole).save(link)
  }

  async deleteUserRole(link: UserRole): Promise<void> {
    await this.em.getRepository(UserRole).remove(link)
  }
}
