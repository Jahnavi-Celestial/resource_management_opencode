import type { DataSource } from 'typeorm'
import { isUuid } from '../../common/db/uuid'
import { isUniqueViolation } from '../../common/db/pg-error'
import { ConflictError } from '../../common/errors/conflict-error'
import { DomainError } from '../../common/errors/domain-error'
import { NotFoundError } from '../../common/errors/not-found-error'
import { assertRoleDeletable } from './lockout-guard'
import { RoleRepository } from './role.repository'
import { Role } from './role.entity'

const ROLE_NAME_UNIQUE_CONSTRAINT = 'uq_role_role_name'

export class RoleService {
  constructor(private readonly dataSource: DataSource) {}

  async getRole(id: string): Promise<Role> {
    const role = isUuid(id) ? await new RoleRepository(this.dataSource.manager).findById(id) : null
    if (role === null) {
      throw new NotFoundError('Role not found')
    }
    return role
  }

  async listRoles(page: number, pageSize: number): Promise<{ items: Role[]; total: number }> {
    const safePage = Math.max(1, Math.floor(page))
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)))
    return new RoleRepository(this.dataSource.manager).list(safePage, safePageSize)
  }

  async createRole(roleName: string): Promise<Role> {
    const name = roleName.trim()
    if (name === '') {
      throw new DomainError('Role name must not be empty')
    }
    const repository = new RoleRepository(this.dataSource.manager)
    const existing = await repository.findByName(name)
    if (existing !== null) {
      throw new ConflictError(`Role "${name}" already exists`)
    }
    try {
      return await repository.insert(name)
    } catch (error: unknown) {
      if (isUniqueViolation(error, ROLE_NAME_UNIQUE_CONSTRAINT)) {
        throw new ConflictError(`Role "${name}" already exists`)
      }
      throw error
    }
  }

  async updateRole(id: string, roleName: string): Promise<Role> {
    const name = roleName.trim()
    if (name === '') {
      throw new DomainError('Role name must not be empty')
    }
    const repository = new RoleRepository(this.dataSource.manager)
    const role = isUuid(id) ? await repository.findById(id) : null
    if (role === null) {
      throw new NotFoundError('Role not found')
    }
    if (role.roleName !== name) {
      const existing = await repository.findByName(name)
      if (existing !== null && existing.id !== role.id) {
        throw new ConflictError(`Role "${name}" already exists`)
      }
      try {
        return await repository.updateName(role, name)
      } catch (error: unknown) {
        if (isUniqueViolation(error, ROLE_NAME_UNIQUE_CONSTRAINT)) {
          throw new ConflictError(`Role "${name}" already exists`)
        }
        throw error
      }
    }
    return role
  }

  async deleteRole(id: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const repository = new RoleRepository(em)
      const role = isUuid(id) ? await repository.findById(id) : null
      if (role === null) {
        throw new NotFoundError('Role not found')
      }
      await assertRoleDeletable(em, role)
      await repository.delete(role)
    })
  }
}
