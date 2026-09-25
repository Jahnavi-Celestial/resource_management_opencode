import { Field, ID, ObjectType } from 'type-graphql'
import { createPaginatedType } from '../../common/pagination/paginated'
import { RoleType } from '../rbac/rbac.types'
import { Employee } from './employee.entity'

@ObjectType('Employee')
export class EmployeeType {
  @Field(() => ID)
  id!: string

  @Field(() => String)
  firstName!: string

  @Field(() => String)
  lastName!: string

  @Field(() => String)
  email!: string

  @Field(() => Date)
  createdAt!: Date

  @Field(() => Date)
  updatedAt!: Date

  @Field(() => [RoleType])
  roles?: RoleType[]

  @Field(() => [EmployeeBookingSummary], { nullable: true })
  bookingHistory!: EmployeeBookingSummary[] | null
}

@ObjectType('EmployeeBookingSummary')
export class EmployeeBookingSummary {
  @Field(() => ID)
  id!: string

  @Field(() => Date)
  startTime!: Date

  @Field(() => Date)
  endTime!: Date

  @Field(() => String)
  purpose!: string

  @Field(() => String)
  status!: string
}

export function toEmployeeType(employee: Employee): EmployeeType {
  const type = new EmployeeType()
  type.id = employee.id
  type.firstName = employee.firstName
  type.lastName = employee.lastName
  type.email = employee.email
  type.createdAt = employee.createdAt
  type.updatedAt = employee.updatedAt
  type.roles = []
  type.bookingHistory = []
  return type
}

export const PaginatedEmployees = createPaginatedType(EmployeeType, 'Employee')
