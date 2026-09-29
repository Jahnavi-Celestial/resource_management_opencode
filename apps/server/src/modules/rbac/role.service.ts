import type { DataSource } from 'typeorm'
import { isUuid } from '../../common/db/uuid'
import { isUniqueViolation } from '../../common/db/pg-error'
import { runInTransaction, type TransactionalEntityManager } from '../../common/db/transaction'
import { ConflictError } from '../../common/errors/conflict-error'
import { DomainError } from '../../common/errors/domain-error'
import { NotFoundError } from '../../common/errors/not-found-error'
import { assertRoleDeletable } from './lockout-guard'
import { assertSystemRoleDeletable, assertSystemRoleRenamable } from './system-role-guard'
import { PermissionRepository } from './permission.repository'
import { RbacRepository } from './rbac.repository'
import { RoleRepository } from './role.repository'
import { Role } from './role.entity'

const ROLE_NAME_UNIQUE_CONSTRAINT = 'uq_role_role_name'

function roleNameExistsError(name: string): ConflictError {
  return new ConflictError(`Role "${name}" already exists`)
}

/**
 * Writes a new role's permission grants inside the caller's transaction. Every
 * id must resolve to a real permission — an unknown id throws and rolls the
 * whole create back, so a role is never persisted with a dangling grant.
 * Duplicate ids are collapsed: the link table's unique constraint would
 * otherwise turn a repeated id into a 23505 mid-create.
 */
async function assignPermissions(
  tx: TransactionalEntityManager,
  roleId: string,
  permissionIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(permissionIds)]
  const permissions = await new PermissionRepository(tx).findByIds(unique)
  if (permissions.length !== unique.length) {
    throw new NotFoundError('Permission not found')
  }
  const repository = new RbacRepository(tx)
  for (const permissionId of unique) {
    await repository.insertRolePermission(roleId, permissionId)
  }
}

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

  async createRole(roleName: string, permissionIds?: readonly string[]): Promise<Role> {
    const name = roleName.trim()
    if (name === '') {
      throw new DomainError('Role name must not be empty')
    }
    const repository = new RoleRepository(this.dataSource.manager)
    const existing = await repository.findByName(name)
    if (existing !== null) {
      throw roleNameExistsError(name)
    }
    if (permissionIds === undefined || permissionIds.length === 0) {
      try {
        return await repository.insert(name)
      } catch (error: unknown) {
        if (isUniqueViolation(error, ROLE_NAME_UNIQUE_CONSTRAINT)) {
          throw roleNameExistsError(name)
        }
        throw error
      }
    }
    // Role row and grants commit together (or not at all): the unique-violation
    // backstop is repeated inside the transaction because a racing duplicate
    // would otherwise surface as a raw 23505 from the rolled-back insert.
    return runInTransaction(this.dataSource, async (tx) => {
      let role: Role
      try {
        role = await new RoleRepository(tx).insert(name)
      } catch (error: unknown) {
        if (isUniqueViolation(error, ROLE_NAME_UNIQUE_CONSTRAINT)) {
          throw roleNameExistsError(name)
        }
        throw error
      }
      await assignPermissions(tx, role.id, permissionIds)
      return role
    })
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
      assertSystemRoleRenamable(role)
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
      // The system-role rule is checked first: it is the stronger, more
      // specific refusal, and it does not depend on which unrelated roles
      // happen to hold `role:assign` in this database. The lockout guard
      // stays as a backstop for a database where the seed was never run.
      assertSystemRoleDeletable(role)
      await assertRoleDeletable(em, role)
      await repository.delete(role)
    })
  }
}
