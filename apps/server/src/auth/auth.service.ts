import type { DataSource } from 'typeorm'
import { InvalidCredentialsError } from '../common/errors/invalid-credentials-error'
import { Employee } from '../modules/employee/employee.entity'
import { isSystemEmployeeEmail } from '../modules/employee/system-account'
import { signEmployeeToken } from './jwt'
import { verifyPassword } from './password'

const DUMMY_PASSWORD_HASH = '$2b$12$40iZySHLcOhTYMEUibV3Tuq8mzDJBguaf7j3Kiq/EFppr4x/kRhJ.'

export class AuthService {
  constructor(private readonly dataSource: DataSource) {}

  async login(email: string, password: string): Promise<string> {
    const normalizedEmail = email.trim().toLowerCase()
    if (isSystemEmployeeEmail(normalizedEmail)) {
      await verifyPassword(password, DUMMY_PASSWORD_HASH)
      throw new InvalidCredentialsError()
    }

    const employee = await this.dataSource
      .getRepository(Employee)
      .findOne({ where: { email: normalizedEmail } })

    if (employee === null || isSystemEmployeeEmail(employee.email)) {
      await verifyPassword(password, DUMMY_PASSWORD_HASH)
      throw new InvalidCredentialsError()
    }

    const passwordMatches = await verifyPassword(password, employee.password)
    if (!passwordMatches) {
      throw new InvalidCredentialsError()
    }

    return signEmployeeToken(employee.id)
  }
}
