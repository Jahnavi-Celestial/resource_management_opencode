import { Field, ObjectType } from 'type-graphql'
import { EmployeeType } from '../modules/employee/employee.types'
import { RoleType } from '../modules/rbac/rbac.types'

@ObjectType()
export class MeType {
  @Field(() => EmployeeType)
  employee!: EmployeeType

  @Field(() => [RoleType])
  roles!: RoleType[]

  @Field(() => [String])
  permissionKeys!: string[]
}
