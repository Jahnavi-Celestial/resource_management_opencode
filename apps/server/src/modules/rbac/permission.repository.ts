import type { EntityManager } from 'typeorm'
import { isUuid } from '../../common/db/uuid'
import { Permission } from './permission.entity'
import { RolePermission } from './role-permission.entity'

export class PermissionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Permission | null> {
    return this.em.getRepository(Permission).findOne({ where: { id } })
  }

  /**
   * Batch lookup by id, skipping non-uuid ids the way `findById` does so a
   * malformed id surfaces as "not found" rather than a Postgres uuid-syntax
   * error. Used by the atomic role-create, which must validate every grant
   * before writing any.
   */
  async findByIds(ids: readonly string[]): Promise<Permission[]> {
    const uuids = ids.filter((id) => isUuid(id))
    if (uuids.length === 0) return []
    return this.em.getRepository(Permission).find({
      where: uuids.map((id) => ({ id })),
    })
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
