import { IsEmail, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator'
import { ArgsType, Field, ID, InputType } from 'type-graphql'
import { PageArgs } from '../../common/pagination/page-args'
import { SortInput } from '../../common/pagination/sort-input'

export const EMPLOYEE_NAME_MAX_LENGTH = 100
export const EMPLOYEE_EMAIL_MAX_LENGTH = 255
export const EMPLOYEE_PASSWORD_MIN_LENGTH = 8
export const EMPLOYEE_PASSWORD_MAX_LENGTH = 72

const NON_BLANK = /\S/

@InputType()
export class CreateEmployeeInput {
  @Field(() => String)
  @IsString()
  @Matches(NON_BLANK, { message: 'First name must not be blank' })
  @MaxLength(EMPLOYEE_NAME_MAX_LENGTH)
  firstName!: string

  @Field(() => String)
  @IsString()
  @Matches(NON_BLANK, { message: 'Last name must not be blank' })
  @MaxLength(EMPLOYEE_NAME_MAX_LENGTH)
  lastName!: string

  @Field(() => String)
  @IsEmail({}, { message: 'Email must be a valid email address' })
  @MaxLength(EMPLOYEE_EMAIL_MAX_LENGTH)
  email!: string

  @Field(() => String)
  @IsString()
  @MinLength(EMPLOYEE_PASSWORD_MIN_LENGTH, { message: 'Password must be at least 8 characters long' })
  @MaxLength(EMPLOYEE_PASSWORD_MAX_LENGTH, { message: 'Password must be at most 72 characters long' })
  password!: string
}

@InputType()
export class UpdateEmployeeInput {
  @Field(() => ID)
  @IsUUID()
  id!: string

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Matches(NON_BLANK, { message: 'First name must not be blank' })
  @MaxLength(EMPLOYEE_NAME_MAX_LENGTH)
  firstName?: string

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Matches(NON_BLANK, { message: 'Last name must not be blank' })
  @MaxLength(EMPLOYEE_NAME_MAX_LENGTH)
  lastName?: string

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEmail({}, { message: 'Email must be a valid email address' })
  @MaxLength(EMPLOYEE_EMAIL_MAX_LENGTH)
  email?: string

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(EMPLOYEE_PASSWORD_MIN_LENGTH, { message: 'Password must be at least 8 characters long' })
  @MaxLength(EMPLOYEE_PASSWORD_MAX_LENGTH, { message: 'Password must be at most 72 characters long' })
  password?: string
}

@ArgsType()
export class EmployeeListArgs extends PageArgs {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  search?: string

  @Field(() => SortInput, { nullable: true })
  @IsOptional()
  sort?: SortInput
}
