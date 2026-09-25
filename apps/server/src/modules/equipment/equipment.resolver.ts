import { Arg, Args, Authorized, Ctx, Mutation, Query, Resolver } from 'type-graphql'
import { GraphQLISODateTime } from 'type-graphql'
import type { DataSource } from 'typeorm'
import type { GraphQLContext } from '../../common/graphql/context'
import type { Paginated } from '../../common/pagination/paginated'
import { getEquipmentFreeQuantity } from '../booking/availability'
import { Equipment } from './equipment.entity'
import { CreateEquipmentInput, EquipmentListArgs, UpdateEquipmentInput } from './equipment.inputs'
import { EquipmentService } from './equipment.service'
import { EquipmentType, EquipmentAvailabilityResult, PaginatedEquipment, toEquipmentType } from './equipment.types'

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

  @Query(() => EquipmentAvailabilityResult)
  @Authorized('equipment:read')
  async equipmentAvailability(
    @Arg('equipmentId', () => String) equipmentId: string,
    @Arg('startDate', () => GraphQLISODateTime) startDate: Date,
    @Arg('endDate', () => GraphQLISODateTime) endDate: Date,
    @Ctx() context: GraphQLContext,
  ): Promise<EquipmentAvailabilityResult> {
    const equipment = await context.dataSource.getRepository(Equipment).findOneOrFail({ where: { id: equipmentId } })
    const remaining = await getEquipmentFreeQuantity(context.dataSource.manager, equipmentId, startDate, endDate)
    return {
      equipmentId: equipment.id,
      name: equipment.name,
      quantityAvailable: equipment.quantityAvailable,
      remainingAvailability: remaining,
    }
  }
}
