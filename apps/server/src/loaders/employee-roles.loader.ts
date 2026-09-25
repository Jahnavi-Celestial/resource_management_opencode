import DataLoader from 'dataloader'
import type { DataSource } from 'typeorm'
import { Role } from '../modules/rbac/role.entity'
import { UserRole } from '../modules/rbac/user-role.entity'

export function createEmployeeRolesLoader(dataSource: DataSource): DataLoader<string, Role[]> {
  return new DataLoader<string, Role[]>(async (employeeIds: readonly string[]) => {
    const userRoles = await dataSource
      .getRepository(UserRole)
      .createQueryBuilder('userRole')
      .innerJoinAndSelect('userRole.role', 'role')
      .where('userRole.employeeId IN (:...employeeIds)', { employeeIds: [...employeeIds] })
      .orderBy('role.roleName', 'ASC')
      .getMany()
    const rolesByEmployeeId = new Map<string, Role[]>()
    for (const userRole of userRoles) {
      const bucket = rolesByEmployeeId.get(userRole.employeeId)
      if (bucket === undefined) {
        rolesByEmployeeId.set(userRole.employeeId, [userRole.role])
      } else {
        bucket.push(userRole.role)
      }
    }
    return employeeIds.map((employeeId) => rolesByEmployeeId.get(employeeId) ?? [])
  })
}
