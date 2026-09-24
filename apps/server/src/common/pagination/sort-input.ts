import { IsIn, IsString } from 'class-validator'
import { Field, InputType } from 'type-graphql'

export const SORT_DIRECTIONS = ['ASC', 'DESC'] as const
export type SortDirection = (typeof SORT_DIRECTIONS)[number]

export type SortableFields = Readonly<Record<string, string>>

@InputType()
export class SortInput {
  @Field(() => String)
  @IsString()
  field!: string

  @Field(() => String, { defaultValue: 'ASC' })
  @IsIn([...SORT_DIRECTIONS])
  direction: SortDirection = 'ASC'
}
