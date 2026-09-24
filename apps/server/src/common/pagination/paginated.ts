import { Field, Int, ObjectType, type ClassType } from 'type-graphql'

export interface Paginated<T> {
  items: T[]
  totalCount: number
}

export function createPaginatedType<T extends object>(
  itemClass: ClassType<T>,
  typeName: string,
): ClassType<Paginated<T>> {
  @ObjectType(`Paginated${typeName}`)
  class PaginatedClass implements Paginated<T> {
    @Field(() => [itemClass])
    items!: T[]

    @Field(() => Int)
    totalCount!: number
  }
  return PaginatedClass
}
