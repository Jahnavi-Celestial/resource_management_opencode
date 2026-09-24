import { Field, ID, InputType } from 'type-graphql'
import { IsUUID } from 'class-validator'

@InputType()
export class RolePermissionInput {
  @Field(() => ID)
  @IsUUID()
  roleId!: string

  @Field(() => ID)
  @IsUUID()
  permissionId!: string
}

@InputType()
export class EmployeeRoleInput {
  @Field(() => ID)
  @IsUUID()
  employeeId!: string

  @Field(() => ID)
  @IsUUID()
  roleId!: string
}
