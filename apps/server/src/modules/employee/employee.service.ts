import type { DataSource } from 'typeorm'
import { hashPassword } from '../../auth/password'
import { runInTransaction } from '../../common/db/transaction'
import type { TransactionalEntityManager } from '../../common/db/transaction'
import { ConflictError } from '../../common/errors/conflict-error'
import { InputValidationError } from '../../common/errors/field-errors'
import { NotFoundError } from '../../common/errors/not-found-error'
import { EmailService } from '../../email/email.service'
import { Role } from '../rbac/role.entity'
import { RbacRepository } from '../rbac/rbac.repository'
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
  private readonly emailService: EmailService

  constructor(private readonly dataSource: DataSource) {
    this.repository = new EmployeeRepository(dataSource.manager)
    this.emailService = new EmailService()
  }

  async create(input: CreateEmployeeInput): Promise<Employee> {
    const email = normalizeEmail(input.email)
    if ((await this.repository.findByEmail(email)) !== null) throw emailInUseError()
    // The employee row and its first role link commit together: a role the
    // server cannot find must leave no employee behind, and a half-created
    // account is exactly what the transaction prevents.
    return runInTransaction(this.dataSource, async (tx) => {
      const repository = new EmployeeRepository(tx)
      let employee: Employee
      try {
        employee = await repository.insert({
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          email,
          passwordHash: await hashPassword(input.password),
        })
      } catch (error: unknown) {
        if (isUniqueViolation(error)) throw emailInUseError()
        throw error
      }
      if (input.roleId !== undefined) {
        const role = await tx.getRepository(Role).findOne({ where: { id: input.roleId } })
        if (role === null) {
          throw new InputValidationError([{ field: 'roleId', message: 'Role not found' }])
        }
        await new RbacRepository(tx).insertUserRole(employee.id, input.roleId)
      }
      this.enqueueWelcomeEmail(tx, employee, input.password)
      return employee
    })
  }

  /**
   * The new account's credentials email. Post-commit, in its own transaction,
   * exactly like the booking decision email: the employee row is already
   * durable when the outbox row is written, and an enqueue failure is logged
   * and swallowed — a mail that cannot be queued must not fail (or roll back)
   * an account that was created successfully.
   *
   * The plaintext password exists only here: the store keeps a hash, so the
   * create input is the one moment it can be emailed.
   */
  private enqueueWelcomeEmail(tx: TransactionalEntityManager, employee: Employee, password: string): void {
    tx.afterCommit(async () => {
      try {
        await runInTransaction(this.dataSource, async (manager) => {
          await this.emailService.enqueueForEmployee(manager, employee.id, 'EMPLOYEE_WELCOME', {
            email: employee.email,
            password,
          })
        })
      } catch (error: unknown) {
        console.error('[employee] post-commit welcome email enqueue failed', error)
      }
    })
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

  async getById(id: string): Promise<Employee> {
    const employee = await this.repository.findById(id)
    if (employee === null) throw new NotFoundError('Employee not found')
    return employee
  }
}
