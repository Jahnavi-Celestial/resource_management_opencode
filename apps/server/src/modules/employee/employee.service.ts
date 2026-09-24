import type { DataSource } from 'typeorm'
import { hashPassword } from '../../auth/password'
import { ConflictError } from '../../common/errors/conflict-error'
import { InputValidationError } from '../../common/errors/field-errors'
import { NotFoundError } from '../../common/errors/not-found-error'
import type { Role } from '../rbac/role.entity'
import type { CreateEmployeeInput, EmployeeListArgs, UpdateEmployeeInput } from './employee.inputs'
import { Employee } from './employee.entity'
import { EmployeeRepository } from './employee.repository'
import { isSystemEmployeeEmail } from './system-account'

const UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } }
  return candidate.code === UNIQUE_VIOLATION || candidate.driverError?.code === UNIQUE_VIOLATION
}

function emailInUseError(): InputValidationError {
  return new InputValidationError([{ field: 'email', message: 'Email is already in use' }])
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export class EmployeeService {
  private readonly repository: EmployeeRepository

  constructor(private readonly dataSource: DataSource) {
    this.repository = new EmployeeRepository(dataSource.manager)
  }

  async create(input: CreateEmployeeInput): Promise<Employee> {
    const email = normalizeEmail(input.email)
    if ((await this.repository.findByEmail(email)) !== null) throw emailInUseError()
    try {
      return await this.repository.insert({
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        email,
        passwordHash: await hashPassword(input.password),
      })
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw emailInUseError()
      throw error
    }
  }

  async update(input: UpdateEmployeeInput): Promise<Employee> {
    const employee = await this.repository.findById(input.id)
    if (employee === null) throw new NotFoundError('Employee not found')

    if (input.firstName !== undefined) employee.firstName = input.firstName.trim()
    if (input.lastName !== undefined) employee.lastName = input.lastName.trim()
    if (input.password !== undefined) employee.password = await hashPassword(input.password)
    if (input.email !== undefined) {
      const email = normalizeEmail(input.email)
      if (email !== employee.email) {
        if (isSystemEmployeeEmail(employee.email)) {
          throw new ConflictError('The system account email cannot be changed')
        }
        if ((await this.repository.findOtherByEmail(email, employee.id)) !== null) throw emailInUseError()
        employee.email = email
      }
    }

    try {
      return await this.repository.save(employee)
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw emailInUseError()
      throw error
    }
  }

  async delete(id: string, actingEmployeeId: string): Promise<void> {
    const employee = await this.repository.findById(id)
    if (employee === null) throw new NotFoundError('Employee not found')
    if (employee.id === actingEmployeeId) {
      throw new ConflictError('Employees cannot delete their own account')
    }
    if (isSystemEmployeeEmail(employee.email)) {
      throw new ConflictError('The system account cannot be deleted')
    }
    await this.repository.delete(employee)
  }

  async list(args: EmployeeListArgs): Promise<{ items: Employee[]; total: number }> {
    return this.repository.list(args)
  }

  async getDetail(id: string): Promise<{ employee: Employee; roles: Role[] }> {
    const employee = await this.repository.findById(id)
    if (employee === null) throw new NotFoundError('Employee not found')
    const roles = await this.repository.findRolesByEmployeeId(employee.id)
    return { employee, roles }
  }
}
