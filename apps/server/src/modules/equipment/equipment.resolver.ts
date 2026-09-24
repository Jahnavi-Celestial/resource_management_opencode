import { Arg, Args, Authorized, Ctx, Mutation, Query, Resolver } from 'type-graphql'
import type { GraphQLContext } from '../../common/graphql/context'
import type { Paginated } from '../../common/pagination/paginated'
import { Equipment } from './equipment.entity'
import { CreateEquipmentInput, EquipmentListArgs, UpdateEquipmentInput } from './equipment.inputs'
import { EquipmentService } from './equipment.service'
import { EquipmentType, PaginatedEquipment, toEquipmentType } from './equipment.types'

@Resolver(() => EquipmentType)
export class EquipmentResolver {
  @Query(() => PaginatedEquipment)
  @Authorized('equipment:read')
  async equipment(
    @Args(() => EquipmentListArgs) args: EquipmentListArgs,
    @Ctx() context: GraphQLContext,
  ): Promise<Paginated<EquipmentType>> {
    const service = new EquipmentService(context.dataSource)
    const { items, total } = await service.list(args)
    return { items: items.map(toEquipmentType), totalCount: total }
  }

  @Mutation(() => EquipmentType)
  @Authorized('equipment:write')
  async createEquipment(
    @Arg('input', () => CreateEquipmentInput) input: CreateEquipmentInput,
    @Ctx() context: GraphQLContext,
  ): Promise<EquipmentType> {
    const service = new EquipmentService(context.dataSource)
    return toEquipmentType(await service.create(input))
  }

  @Mutation(() => EquipmentType)
  @Authorized('equipment:write')
  async updateEquipment(
    @Arg('input', () => UpdateEquipmentInput) input: UpdateEquipmentInput,
    @Ctx() context: GraphQLContext,
  ): Promise<EquipmentType> {
    const service = new EquipmentService(context.dataSource)
    return toEquipmentType(await service.update(input))
  }
}
