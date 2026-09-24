import { Field, ID, Int, ObjectType } from 'type-graphql'
import { createPaginatedType } from '../../common/pagination/paginated'
import { Equipment } from './equipment.entity'

@ObjectType('Equipment')
export class EquipmentType {
  @Field(() => ID)
  id!: string

  @Field(() => String)
  name!: string

  @Field(() => Int)
  quantityAvailable!: number

  @Field(() => Boolean)
  isActive!: boolean

  @Field(() => Date)
  createdAt!: Date

  @Field(() => Date)
  updatedAt!: Date
}

export function toEquipmentType(equipment: Equipment): EquipmentType {
  const type = new EquipmentType()
  type.id = equipment.id
  type.name = equipment.name
  type.quantityAvailable = equipment.quantityAvailable
  type.isActive = equipment.isActive
  type.createdAt = equipment.createdAt
  type.updatedAt = equipment.updatedAt
  return type
}

export const PaginatedEquipment = createPaginatedType(EquipmentType, 'Equipment')
