import { Arg, Args, Authorized, Ctx, Mutation, Query, Resolver } from 'type-graphql'
import type { DataSource } from 'typeorm'
import { GraphQLISODateTime } from 'type-graphql'
import type { GraphQLContext } from '../../common/graphql/context'
import type { Paginated } from '../../common/pagination/paginated'
import { BookingRepository } from '../booking/booking.repository'
import { Booking } from '../booking/booking.entity'
import { CreateRoomInput, RoomListArgs, UpdateRoomInput } from './room.inputs'
import { RoomService } from './room.service'
import { RoomType, RoomBookingSummary, PaginatedRooms, toRoomType } from './room.types'

@Resolver(() => RoomType)
export class RoomResolver {
  @Query(() => PaginatedRooms)
  @Authorized('room:read')
  async rooms(
    @Args(() => RoomListArgs) args: RoomListArgs,
    @Ctx() context: GraphQLContext,
  ): Promise<Paginated<RoomType>> {
    const service = new RoomService(context.dataSource)
    const { items, total } = await service.list(args)
    return { items: items.map(toRoomType), totalCount: total }
  }

  @Mutation(() => RoomType)
  @Authorized('room:write')
  async createRoom(
    @Arg('input', () => CreateRoomInput) input: CreateRoomInput,
    @Ctx() context: GraphQLContext,
  ): Promise<RoomType> {
    const service = new RoomService(context.dataSource)
    return toRoomType(await service.create(input))
  }

  @Mutation(() => RoomType)
  @Authorized('room:write')
  async updateRoom(
    @Arg('input', () => UpdateRoomInput) input: UpdateRoomInput,
    @Ctx() context: GraphQLContext,
  ): Promise<RoomType> {
    const service = new RoomService(context.dataSource)
    return toRoomType(await service.update(input))
  }

  @Query(() => [RoomBookingSummary])
  @Authorized('room:read')
  async roomAvailability(
    @Arg('roomId', () => String) roomId: string,
    @Arg('startDate', () => GraphQLISODateTime) startDate: Date,
    @Arg('endDate', () => GraphQLISODateTime) endDate: Date,
    @Ctx() context: GraphQLContext,
  ): Promise<RoomBookingSummary[]> {
    const repository = new BookingRepository()
    const bookings = await repository.findRoomAvailability(
      context.dataSource.manager,
      roomId,
      startDate,
      endDate,
    )
    return bookings.map((b) => ({
      id: b.id,
      startTime: b.startTime,
      endTime: b.endTime,
      purpose: b.purpose,
      status: b.status,
    }))
  }
}
