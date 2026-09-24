import type { EntityManager } from 'typeorm'
import { Permission } from './permission.entity'
import { RolePermission } from './role-permission.entity'

export class PermissionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Permission | null> {
    return this.em.getRepository(Permission).findOne({ where: { id } })
  }

  async findByName(permissionName: string): Promise<Permission | null> {
    return this.em.getRepository(Permission).findOne({ where: { permissionName } })
  }

  async list(page: number, pageSize: number): Promise<{ items: Permission[]; total: number }> {
    const [items, total] = await this.em.getRepository(Permission).findAndCount({
      order: { permissionName: 'ASC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    })
    return { items, total }
  }

  async listByNames(permissionNames: readonly string[]): Promise<Permission[]> {
    if (permissionNames.length === 0) return []
    return this.em.getRepository(Permission).find({
      where: permissionNames.map((permissionName) => ({ permissionName })),
    })
  }

  async listForRole(roleId: string): Promise<Permission[]> {
    return this.em
      .getRepository(Permission)
      .createQueryBuilder('permission')
      .innerJoin(RolePermission, 'rolePermission', 'rolePermission.permission_id = permission.id')
      .where('rolePermission.role_id = :roleId', { roleId })
      .orderBy('permission.permission_name', 'ASC')
      .getMany()
  }
}
