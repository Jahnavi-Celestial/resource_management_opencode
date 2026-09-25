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
}

export function toEmployeeType(employee: Employee): EmployeeType {
  const type = new EmployeeType()
  type.id = employee.id
  type.firstName = employee.firstName
  type.lastName = employee.lastName
  type.email = employee.email
  type.createdAt = employee.createdAt
  type.updatedAt = employee.updatedAt
  return type
}

export const PaginatedEmployees = createPaginatedType(EmployeeType, 'Employee')
