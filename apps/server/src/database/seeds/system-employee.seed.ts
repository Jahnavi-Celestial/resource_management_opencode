import { randomBytes } from 'node:crypto'
import type { DataSource } from 'typeorm'
import { hashPassword } from '../../auth/password'
import { Employee } from '../../modules/employee/employee.entity'
import { SYSTEM_EMPLOYEE_EMAIL } from '../../modules/employee/system-account'

export async function seedSystemEmployee(dataSource: DataSource): Promise<void> {
  const repository = dataSource.getRepository(Employee)
  const existing = await repository.findOne({ where: { email: SYSTEM_EMPLOYEE_EMAIL } })
  if (existing !== null) {
    console.log(`system employee "${SYSTEM_EMPLOYEE_EMAIL}" already present`)
    return
  }

  const unguessablePassword = randomBytes(32).toString('hex')
  await repository.save({
    firstName: 'System',
    lastName: 'Employee',
    email: SYSTEM_EMPLOYEE_EMAIL,
    password: await hashPassword(unguessablePassword),
  } as Employee)

  console.log(`system employee "${SYSTEM_EMPLOYEE_EMAIL}" created (login permanently refused)`)
}
