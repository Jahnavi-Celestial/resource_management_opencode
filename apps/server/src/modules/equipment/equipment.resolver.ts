import { Arg, Args, Authorized, Ctx, Mutation, Query, Resolver } from 'type-graphql'
import { GraphQLISODateTime } from 'type-graphql'
import { In } from 'typeorm'
import type { DataSource } from 'typeorm'
import type { GraphQLContext } from '../../common/graphql/context'
import type { Paginated } from '../../common/pagination/paginated'
import { MAX_PAGE_SIZE } from '../../common/pagination/page-args'
import { equipmentAvailabilityKey, getEquipmentFreeQuantity, getEquipmentFreeQuantities } from '../booking/availability'
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
    const types = items.map(toEquipmentType)
    // The dynamic half of the "Available" column: what is free *right now*, one
    // batched query for the whole page rather than one per row. The window is a
    // single moment, so "overlapping it" is `startTime < now AND endTime > now`
    // — the same FR-35 committed definition the booking form's panel asks
    // about, so the two screens can never disagree about the same item.
    const now = new Date()
    const windows = items.map((item) => ({ equipmentId: item.id, startTime: now, endTime: now }))
    const free = await getEquipmentFreeQuantities(context.dataSource.manager, windows)
    types.forEach((type, index) => {
      const window = windows[index]
      const item = items[index]
      if (window === undefined || item === undefined) {
        return
      }
      type.availableNow = free.get(equipmentAvailabilityKey(window)) ?? item.quantityAvailable
    })
    return { items: types, totalCount: total }
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

  /**
   * The same answer as `equipmentAvailability`, for many items in one request.
   *
   * The booking form's equipment *select* needs the window-aware remaining
   * quantity of every bookable item, and the per-item query cannot answer
   * that: a select of ten options is ten requests, and the endpoint takes one
   * item per call. This is the batched form — one aggregate query over the
   * same FR-35 committed definition, reusing `getEquipmentFreeQuantities` —
   * and it is additive: the per-item query is untouched, and the availability
   * panel keeps calling it once per selected line.
   *
   * The id list is capped at `MAX_PAGE_SIZE` (NFR-2: no unbounded input), the
   * same bound the option lists the form already fetches under.
   */
  @Query(() => [EquipmentAvailabilityResult])
  @Authorized('equipment:read')
  async equipmentAvailabilityForWindow(
    @Arg('equipmentIds', () => [String]) equipmentIds: string[],
    @Arg('startDate', () => GraphQLISODateTime) startDate: Date,
    @Arg('endDate', () => GraphQLISODateTime) endDate: Date,
    @Ctx() context: GraphQLContext,
  ): Promise<EquipmentAvailabilityResult[]> {
    const ids = equipmentIds.slice(0, MAX_PAGE_SIZE)
    if (ids.length === 0) {
      return []
    }
    const equipments = await context.dataSource.getRepository(Equipment).find({ where: { id: In(ids) } })
    const byId = new Map(equipments.map((equipment) => [equipment.id, equipment]))
    const windows = ids.map((equipmentId) => ({ equipmentId, startTime: startDate, endTime: endDate }))
    const free = await getEquipmentFreeQuantities(context.dataSource.manager, windows)
    return ids.map((equipmentId) => {
      const equipment = byId.get(equipmentId)
      return {
        equipmentId,
        name: equipment?.name ?? '',
        quantityAvailable: equipment?.quantityAvailable ?? 0,
        remainingAvailability:
          free.get(equipmentAvailabilityKey({ equipmentId, startTime: startDate, endTime: endDate })) ??
          equipment?.quantityAvailable ??
          0,
      }
    })
  }
}
