import type { DataSource } from 'typeorm'
import { hashPassword, verifyPassword } from '../../auth/password'
import { Employee } from '../../modules/employee/employee.entity'
import { Role } from '../../modules/rbac/role.entity'
import { UserRole } from '../../modules/rbac/user-role.entity'
import { isSystemEmployeeEmail } from '../../modules/employee/system-account'

export interface BootstrapPerson {
  email: string
  password: string
  roleName: string
  firstName: string
  lastName: string
}

/**
 * Seeds one loginable person holding one role: the Admin, the Manager and the
 * Employee each come through here, so the three share one implementation rather
 * than three copies that can drift.
 *
 * Refusal is by identity, not by secret: the system account is the actor on
 * every FR-72 COMPLETE audit row, so a person must never be able to hold it.
 * That is why this asserts the email is not the system's — without the guard, a
 * single mistyped line in .env would hand a role to the audit actor and make
 * audit attribution forgeable.
 */
export async function seedBootstrapPerson(
  dataSource: DataSource,
  person: BootstrapPerson,
): Promise<void> {
  const { email, password, roleName, firstName, lastName } = person

  if (isSystemEmployeeEmail(email)) {
    throw new Error(
      `Refusing to seed "${email}" as "${roleName}": that is the system account, which must hold no roles`,
    )
  }

  const employeeRepository = dataSource.getRepository(Employee)
  const roleRepository = dataSource.getRepository(Role)
  const userRoleRepository = dataSource.getRepository(UserRole)

  let employee = await employeeRepository.findOne({ where: { email } })

  if (employee === null) {
    employee = await employeeRepository.save({
      firstName,
      lastName,
      email,
      password: await hashPassword(password),
    } as Employee)
    console.log(`bootstrap ${roleName} "${email}" created`)
  } else {
    const passwordMatches = await verifyPassword(password, employee.password)
    if (!passwordMatches) {
      await employeeRepository.update({ id: employee.id }, { password: await hashPassword(password) })
      console.log(`bootstrap ${roleName} "${email}" password synced`)
    } else {
      console.log(`bootstrap ${roleName} "${email}" already present`)
    }
  }

  const role = await roleRepository.findOne({ where: { roleName } })
  if (role === null) {
    throw new Error(`role "${roleName}" is missing — run the roles seed first`)
  }

  const existingLink = await userRoleRepository.findOne({
    where: { employeeId: employee.id, roleId: role.id },
  })
  if (existingLink === null) {
    await userRoleRepository
      .createQueryBuilder()
      .insert()
      .values({ employeeId: employee.id, roleId: role.id })
      .orIgnore()
      .execute()
    console.log(`bootstrap ${roleName} "${email}" assigned the "${roleName}" role`)
  }
}
