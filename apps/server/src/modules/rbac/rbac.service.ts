import type { DataSource, EntityManager } from 'typeorm'
import { Employee } from '../employee/employee.entity'
import { isUuid } from '../../common/db/uuid'
import { isUniqueViolation } from '../../common/db/pg-error'
import { ConflictError } from '../../common/errors/conflict-error'
import { NotFoundError } from '../../common/errors/not-found-error'
import { Role } from './role.entity'
import { Permission } from './permission.entity'
import { PermissionRepository } from './permission.repository'
import { RbacRepository } from './rbac.repository'
import { RoleRepository } from './role.repository'
import { assertPermissionRemovable, assertRoleRemovableFromEmployee } from './lockout-guard'

const ROLE_PERMISSION_UNIQUE_CONSTRAINT = 'uq_role_permission_role_id_permission_id'
const USER_ROLE_UNIQUE_CONSTRAINT = 'uq_user_role_employee_id_role_id'

async function findEmployeeOrThrow(dataSource: DataSource, employeeId: string): Promise<Employee> {
  const employee = isUuid(employeeId)
    ? await dataSource.getRepository(Employee).findOne({ where: { id: employeeId } })
    : null
  if (employee === null) {
    throw new NotFoundError('Employee not found')
  }
  return employee
}

async function findRoleOrThrow(em: EntityManager, roleId: string): Promise<Role> {
  const role = isUuid(roleId) ? await new RoleRepository(em).findById(roleId) : null
  if (role === null) {
    throw new NotFoundError('Role not found')
  }
  return role
}

async function findPermissionOrThrow(em: EntityManager, permissionId: string): Promise<Permission> {
  const permission = isUuid(permissionId)
    ? await new PermissionRepository(em).findById(permissionId)
    : null
  if (permission === null) {
    throw new NotFoundError('Permission not found')
  }
  return permission
}

export class RbacService {
  constructor(private readonly dataSource: DataSource) {}

  async assignPermissionToRole(roleId: string, permissionId: string): Promise<Role> {
    const repository = new RbacRepository(this.dataSource.manager)
    const role = await findRoleOrThrow(this.dataSource.manager, roleId)
    await findPermissionOrThrow(this.dataSource.manager, permissionId)
    const existing = await repository.findRolePermission(roleId, permissionId)
    if (existing !== null) {
      throw new ConflictError('Permission is already assigned to this role')
    }
    try {
      await repository.insertRolePermission(roleId, permissionId)
    } catch (error: unknown) {
      if (isUniqueViolation(error, ROLE_PERMISSION_UNIQUE_CONSTRAINT)) {
        throw new ConflictError('Permission is already assigned to this role')
      }
      throw error
    }
    return role
  }

  async removePermissionFromRole(roleId: string, permissionId: string): Promise<Role> {
    return this.dataSource.transaction(async (em) => {
      const repository = new RbacRepository(em)
      const role = await findRoleOrThrow(em, roleId)
      const permission = await findPermissionOrThrow(em, permissionId)
      const link = await repository.findRolePermission(roleId, permissionId)
      if (link === null) {
        throw new NotFoundError('Permission is not assigned to this role')
      }
      await assertPermissionRemovable(em, role, permission)
      await repository.deleteRolePermission(link)
      return role
    })
  }

  async assignRoleToEmployee(employeeId: string, roleId: string): Promise<Employee> {
    const repository = new RbacRepository(this.dataSource.manager)
    const employee = await findEmployeeOrThrow(this.dataSource, employeeId)
    await findRoleOrThrow(this.dataSource.manager, roleId)
    const existing = await repository.findUserRole(employeeId, roleId)
    if (existing !== null) {
      throw new ConflictError('Role is already assigned to this employee')
    }
    try {
      await repository.insertUserRole(employeeId, roleId)
    } catch (error: unknown) {
      if (isUniqueViolation(error, USER_ROLE_UNIQUE_CONSTRAINT)) {
        throw new ConflictError('Role is already assigned to this employee')
      }
      throw error
    }
    return employee
  }

  async removeRoleFromEmployee(employeeId: string, roleId: string): Promise<Employee> {
    return this.dataSource.transaction(async (em) => {
      const repository = new RbacRepository(em)
      const employee = await findEmployeeOrThrow(this.dataSource, employeeId)
      const role = await findRoleOrThrow(em, roleId)
      const link = await repository.findUserRole(employeeId, roleId)
      if (link === null) {
        throw new NotFoundError('Role is not assigned to this employee')
      }
      await assertRoleRemovableFromEmployee(em, employee.id, role)
      await repository.deleteUserRole(link)
      return employee
    })
  }
}
