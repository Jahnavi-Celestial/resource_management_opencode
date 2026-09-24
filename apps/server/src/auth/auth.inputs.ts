import { Field, InputType } from 'type-graphql'
import { IsEmail, IsNotEmpty, MaxLength } from 'class-validator'

@InputType()
export class LoginInput {
  @Field(() => String)
  @IsEmail()
  email!: string

  @Field(() => String)
  @IsNotEmpty()
  @MaxLength(256)
  password!: string
}
