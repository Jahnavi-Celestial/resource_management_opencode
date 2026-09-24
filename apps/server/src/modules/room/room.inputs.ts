import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator'
import { ArgsType, Field, ID, InputType, Int } from 'type-graphql'
import { PageArgs } from '../../common/pagination/page-args'
import { SortInput } from '../../common/pagination/sort-input'

export const ROOM_TEXT_MAX_LENGTH = 100
export const ROOM_MIN_CAPACITY = 1

const NON_BLANK = /\S/

@InputType()
export class CreateRoomInput {
  @Field(() => String)
  @IsString()
  @Matches(NON_BLANK, { message: 'Name must not be blank' })
  @MaxLength(ROOM_TEXT_MAX_LENGTH)
  name!: string

  @Field(() => String)
  @IsString()
  @Matches(NON_BLANK, { message: 'Location must not be blank' })
  @MaxLength(ROOM_TEXT_MAX_LENGTH)
  location!: string

  @Field(() => Int)
  @IsInt()
  @Min(ROOM_MIN_CAPACITY, { message: 'Capacity must be at least 1' })
  capacity!: number
}

@InputType()
export class UpdateRoomInput {
  @Field(() => ID)
  @IsUUID()
  id!: string

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Matches(NON_BLANK, { message: 'Name must not be blank' })
  @MaxLength(ROOM_TEXT_MAX_LENGTH)
  name?: string

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Matches(NON_BLANK, { message: 'Location must not be blank' })
  @MaxLength(ROOM_TEXT_MAX_LENGTH)
  location?: string

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(ROOM_MIN_CAPACITY, { message: 'Capacity must be at least 1' })
  capacity?: number

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean
}

@ArgsType()
export class RoomListArgs extends PageArgs {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  search?: string

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(ROOM_MIN_CAPACITY)
  minCapacity?: number

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(ROOM_MIN_CAPACITY)
  maxCapacity?: number

  @Field(() => Boolean, { defaultValue: false })
  @IsBoolean()
  activeOnly: boolean = false

  @Field(() => SortInput, { nullable: true })
  @IsOptional()
  sort?: SortInput
}
