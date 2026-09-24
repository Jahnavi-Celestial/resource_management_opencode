import type { DataSource } from 'typeorm'
import { isUuid } from '../common/db/uuid'
import { Employee } from '../modules/employee/employee.entity'
import { isSystemEmployeeEmail } from '../modules/employee/system-account'
import { Permission } from '../modules/rbac/permission.entity'
import { Role } from '../modules/rbac/role.entity'
import { RolePermission } from '../modules/rbac/role-permission.entity'
import { UserRole } from '../modules/rbac/user-role.entity'
import { verifyEmployeeToken } from './jwt'

export interface ResolvedAuthContext {
  employee: Employee
  roles: Role[]
  permissionKeys: Set<string>
}

export async function resolveAuthContext(
  dataSource: DataSource,
  token: string | null | undefined,
): Promise<ResolvedAuthContext | null> {
  const employeeId = verifyEmployeeToken(token)
  if (employeeId === null || !isUuid(employeeId)) return null

  const employee = await dataSource.getRepository(Employee).findOne({ where: { id: employeeId } })
  if (employee === null || isSystemEmployeeEmail(employee.email)) return null

  const roles = await dataSource
    .getRepository(Role)
    .createQueryBuilder('role')
    .innerJoin(UserRole, 'userRole', 'userRole.role_id = role.id')
    .where('userRole.employee_id = :employeeId', { employeeId })
    .getMany()

  const rawPermissions = await dataSource
    .getRepository(Permission)
    .createQueryBuilder('permission')
    .select('DISTINCT permission.permission_name', 'permissionName')
    .innerJoin(RolePermission, 'rolePermission', 'rolePermission.permission_id = permission.id')
    .innerJoin(UserRole, 'userRole', 'userRole.role_id = rolePermission.role_id')
    .where('userRole.employee_id = :employeeId', { employeeId })
    .getRawMany<{ permissionName: string }>()

  const permissionKeys = new Set<string>(rawPermissions.map((row) => row.permissionName))
  return { employee, roles, permissionKeys }
}
