import { Arg, Args, Authorized, Ctx, Mutation, Query, Resolver } from 'type-graphql'
import type { GraphQLContext } from '../../common/graphql/context'
import type { Paginated } from '../../common/pagination/paginated'
import { CreateRoomInput, RoomListArgs, UpdateRoomInput } from './room.inputs'
import { RoomService } from './room.service'
import { PaginatedRooms, RoomType, toRoomType } from './room.types'

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
}
