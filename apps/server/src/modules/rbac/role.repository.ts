import type { EntityManager } from 'typeorm'
import { Role } from './role.entity'

export class RoleRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Role | null> {
    return this.em.getRepository(Role).findOne({ where: { id } })
  }

  /**
   * Case-insensitive lookup, matching the LOWER(role_name) unique index from
   * migration 1790176946849. `Admin`, `admin` and `ADMIN` are one role, so a
   * duplicate check built on this cannot be bypassed by re-casing the name.
   */
  async findByName(roleName: string): Promise<Role | null> {
    return this.em
      .getRepository(Role)
      .createQueryBuilder('role')
      .where('LOWER(role.roleName) = LOWER(:roleName)', { roleName })
      .getOne()
  }

  async list(page: number, pageSize: number): Promise<{ items: Role[]; total: number }> {
    const [items, total] = await this.em.getRepository(Role).findAndCount({
      order: { roleName: 'ASC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    })
    return { items, total }
  }

  async insert(roleName: string): Promise<Role> {
    const role = new Role()
    role.roleName = roleName
    return this.em.getRepository(Role).save(role)
  }

  async updateName(role: Role, roleName: string): Promise<Role> {
    role.roleName = roleName
    return this.em.getRepository(Role).save(role)
  }

  async delete(role: Role): Promise<void> {
    await this.em.getRepository(Role).remove(role)
  }
}
