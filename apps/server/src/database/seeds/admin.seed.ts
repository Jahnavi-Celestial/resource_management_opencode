import type { DataSource } from 'typeorm'
import { loadEnv } from '../../config/env'
import { hashPassword, verifyPassword } from '../../auth/password'
import { Employee } from '../../modules/employee/employee.entity'
import { Role } from '../../modules/rbac/role.entity'
import { UserRole } from '../../modules/rbac/user-role.entity'
import { ADMIN_ROLE_NAME } from './roles.seed'

export async function seedAdmin(dataSource: DataSource): Promise<void> {
  const { email, password } = loadEnv().admin

  const employeeRepository = dataSource.getRepository(Employee)
  const roleRepository = dataSource.getRepository(Role)
  const userRoleRepository = dataSource.getRepository(UserRole)

  let employee = await employeeRepository.findOne({ where: { email } })

  if (employee === null) {
    employee = await employeeRepository.save({
      firstName: 'Bootstrap',
      lastName: 'Admin',
      email,
      password: await hashPassword(password),
    } as Employee)
    console.log(`bootstrap admin "${email}" created with the Admin role`)
  } else {
    const passwordMatches = await verifyPassword(password, employee.password)
    if (!passwordMatches) {
      await employeeRepository.update({ id: employee.id }, { password: await hashPassword(password) })
      console.log(`bootstrap admin "${email}" password synced to ADMIN_PASSWORD`)
    } else {
      console.log(`bootstrap admin "${email}" already present`)
    }
  }

  const adminRole = await roleRepository.findOne({ where: { roleName: ADMIN_ROLE_NAME } })
  if (adminRole === null) {
    throw new Error(`role "${ADMIN_ROLE_NAME}" is missing — run the roles seed first`)
  }

  const existingLink = await userRoleRepository.findOne({
    where: { employeeId: employee.id, roleId: adminRole.id },
  })
  if (existingLink === null) {
    await userRoleRepository
      .createQueryBuilder()
      .insert()
      .values({ employeeId: employee.id, roleId: adminRole.id })
      .orIgnore()
      .execute()
    console.log(`bootstrap admin "${email}" assigned the "${ADMIN_ROLE_NAME}" role`)
  }
}
