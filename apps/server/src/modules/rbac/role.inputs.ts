import { Field, ID, InputType } from 'type-graphql'
import { IsNotEmpty, IsUUID, MaxLength } from 'class-validator'

@InputType()
export class CreateRoleInput {
  @Field(() => String)
  @IsNotEmpty()
  @MaxLength(100)
  roleName!: string

  /**
   * Permission links written in the same transaction as the role row, so a
   * refused permission id rolls the whole create back — no role is ever left
   * behind with half its grants. Optional: a role with no permissions is
   * valid (it can be granted them later through `assignPermissionToRole`).
   */
  @Field(() => [ID], { nullable: true })
  @IsUUID(undefined, { each: true })
  permissionIds?: string[]
}

@InputType()
export class UpdateRoleInput {
  @Field(() => ID)
  @IsUUID()
  id!: string

  @Field(() => String)
  @IsNotEmpty()
  @MaxLength(100)
  roleName!: string
}
