import { randomBytes } from 'node:crypto'
import type { DataSource } from 'typeorm'
import { hashPassword } from '../../auth/password'
import { Employee } from '../../modules/employee/employee.entity'
import { SYSTEM_EMPLOYEE_EMAIL } from '../../modules/employee/system-account'

/**
 * The system employee is the actor on every FR-72 COMPLETE audit row, so it is
 * not a login: AuthService and resolve-auth-context refuse it by identity. Its
 * email is the SYSTEM_EMPLOYEE_EMAIL constant rather than an env var precisely
 * because those refusals key off that same value — a configurable email would be
 * one config file away from a forgeable audit actor.
 *
 * The password is 32 random bytes that exist nowhere, so nothing on this row
 * could authenticate it even if a refusal were removed.
 */
export async function seedSystemEmployee(dataSource: DataSource): Promise<void> {
  const repository = dataSource.getRepository(Employee)
  const existing = await repository.findOne({ where: { email: SYSTEM_EMPLOYEE_EMAIL } })
  if (existing !== null) {
    console.log(`system employee "${SYSTEM_EMPLOYEE_EMAIL}" already present`)
    return
  }

  await repository.save({
    firstName: 'System',
    lastName: 'Employee',
    email: SYSTEM_EMPLOYEE_EMAIL,
    password: await hashPassword(randomBytes(32).toString('hex')),
  } as Employee)

  console.log(`system employee "${SYSTEM_EMPLOYEE_EMAIL}" created (login permanently refused)`)
}
