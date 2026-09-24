import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator'
import { ArgsType, Field, ID, InputType, Int } from 'type-graphql'
import { PageArgs } from '../../common/pagination/page-args'
import { SortInput } from '../../common/pagination/sort-input'

export const EQUIPMENT_NAME_MAX_LENGTH = 100
export const EQUIPMENT_MIN_QUANTITY = 0

const NON_BLANK = /\S/

@InputType()
export class CreateEquipmentInput {
  @Field(() => String)
  @IsString()
  @Matches(NON_BLANK, { message: 'Name must not be blank' })
  @MaxLength(EQUIPMENT_NAME_MAX_LENGTH)
  name!: string

  @Field(() => Int)
  @IsInt()
  @Min(EQUIPMENT_MIN_QUANTITY, { message: 'Quantity available must be 0 or greater' })
  quantityAvailable!: number
}

@InputType()
export class UpdateEquipmentInput {
  @Field(() => ID)
  @IsUUID()
  id!: string

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Matches(NON_BLANK, { message: 'Name must not be blank' })
  @MaxLength(EQUIPMENT_NAME_MAX_LENGTH)
  name?: string

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(EQUIPMENT_MIN_QUANTITY, { message: 'Quantity available must be 0 or greater' })
  quantityAvailable?: number

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean
}

@ArgsType()
export class EquipmentListArgs extends PageArgs {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  search?: string

  @Field(() => Boolean, { defaultValue: false })
  @IsBoolean()
  activeOnly: boolean = false

  @Field(() => SortInput, { nullable: true })
  @IsOptional()
  sort?: SortInput
}
