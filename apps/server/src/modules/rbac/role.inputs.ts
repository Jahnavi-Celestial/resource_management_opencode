import { Field, ID, InputType } from 'type-graphql'
import { IsNotEmpty, IsUUID, MaxLength } from 'class-validator'

@InputType()
export class CreateRoleInput {
  @Field(() => String)
  @IsNotEmpty()
  @MaxLength(100)
  roleName!: string
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
