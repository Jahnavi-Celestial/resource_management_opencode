import { IsInt, Min } from 'class-validator'
import { ArgsType, Field, Int } from 'type-graphql'

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

@ArgsType()
export class PageArgs {
  @Field(() => Int, { defaultValue: 1 })
  @IsInt()
  @Min(1)
  page: number = 1

  @Field(() => Int, { defaultValue: DEFAULT_PAGE_SIZE })
  @IsInt()
  @Min(1)
  pageSize: number = DEFAULT_PAGE_SIZE
}
