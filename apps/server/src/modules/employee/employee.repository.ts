import type { EntityManager } from 'typeorm'
import { isUuid } from '../../common/db/uuid'
import { applyPagination } from '../../common/pagination/apply-pagination'
import type { SortableFields } from '../../common/pagination/sort-input'
import type { EmployeeListArgs } from './employee.inputs'
import { Employee } from './employee.entity'
import { SYSTEM_EMPLOYEE_EMAIL } from './system-account'

export const EMPLOYEE_SORTABLE_FIELDS: SortableFields = {
  firstName: 'employee.first_name',
  lastName: 'employee.last_name',
  email: 'employee.email',
  createdAt: 'employee.created_at',
  updatedAt: 'employee.updated_at',
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}

export class EmployeeRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Employee | null> {
    if (!isUuid(id)) return null
    return this.em.getRepository(Employee).findOne({ where: { id } })
  }

  async findByEmail(email: string): Promise<Employee | null> {
    return this.em.getRepository(Employee).findOne({ where: { email } })
  }

  async findOtherByEmail(email: string, excludeEmployeeId: string): Promise<Employee | null> {
    return this.em
      .getRepository(Employee)
      .createQueryBuilder('employee')
      .where('employee.email = :email', { email })
      .andWhere('employee.id <> :excludeEmployeeId', { excludeEmployeeId })
      .getOne()
  }

  async insert(data: {
    firstName: string
    lastName: string
    email: string
    passwordHash: string
  }): Promise<Employee> {
    const employee = new Employee()
    employee.firstName = data.firstName
    employee.lastName = data.lastName
    employee.email = data.email
    employee.password = data.passwordHash
    return this.em.getRepository(Employee).save(employee)
  }

  async save(employee: Employee): Promise<Employee> {
    return this.em.getRepository(Employee).save(employee)
  }

  async delete(employee: Employee): Promise<void> {
    await this.em.getRepository(Employee).remove(employee)
  }

  async list(args: EmployeeListArgs): Promise<{ items: Employee[]; total: number }> {
    const qb = this.em
      .getRepository(Employee)
      .createQueryBuilder('employee')
      .where('employee.email <> :systemEmail', { systemEmail: SYSTEM_EMPLOYEE_EMAIL })
    const search = args.search?.trim()
    if (search !== undefined && search !== '') {
      const pattern = `%${escapeLike(search)}%`
      qb.andWhere(
        '(employee.first_name ILIKE :pattern OR employee.last_name ILIKE :pattern OR employee.email ILIKE :pattern)',
        { pattern },
      )
    }
    applyPagination(qb, args, args.sort, EMPLOYEE_SORTABLE_FIELDS)
    if (args.sort === undefined || args.sort === null) {
      qb.orderBy('employee.created_at', 'ASC')
    }
    qb.addOrderBy('employee.id', 'ASC')
    const [items, total] = await qb.getManyAndCount()
    return { items, total }
  }
}
