import { Field, ID, Int, ObjectType } from 'type-graphql'
import { createPaginatedType } from '../../common/pagination/paginated'
import { MeetingRoom } from './room.entity'

@ObjectType('Room')
export class RoomType {
  @Field(() => ID)
  id!: string

  @Field(() => String)
  name!: string

  @Field(() => String)
  location!: string

  @Field(() => Int)
  capacity!: number

  @Field(() => Boolean)
  isActive!: boolean

  @Field(() => Date)
  createdAt!: Date

  @Field(() => Date)
  updatedAt!: Date
}

export function toRoomType(room: MeetingRoom): RoomType {
  const type = new RoomType()
  type.id = room.id
  type.name = room.name
  type.location = room.location
  type.capacity = room.capacity
  type.isActive = room.isActive
  type.createdAt = room.createdAt
  type.updatedAt = room.updatedAt
  return type
}

export const PaginatedRooms = createPaginatedType(RoomType, 'Room')
