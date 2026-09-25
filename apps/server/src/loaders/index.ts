import type DataLoader from 'dataloader'
import type { DataSource } from 'typeorm'
import type { Employee } from '../modules/employee/employee.entity'
import type { Permission } from '../modules/rbac/permission.entity'
import type { Role } from '../modules/rbac/role.entity'
import { createEmployeeLoader } from './employee.loader'
import { createEmployeeRolesLoader } from './employee-roles.loader'
import { createRolePermissionsLoader } from './role-permissions.loader'

export interface Loaders {
  employee: DataLoader<string, Employee | null>
  employeeRoles: DataLoader<string, Role[]>
  rolePermissions: DataLoader<string, Permission[]>
}

export function createLoaders(dataSource: DataSource): Loaders {
  return {
    employee: createEmployeeLoader(dataSource),
    employeeRoles: createEmployeeRolesLoader(dataSource),
    rolePermissions: createRolePermissionsLoader(dataSource),
  }
}
