import { Arg, Authorized, Ctx, Int, Query, Resolver } from 'type-graphql'
import type { BookingStatus } from '@resource-booking/shared'
import type { GraphQLContext } from '../../common/graphql/context'
import { ReportRangeInput } from './report.inputs'
import { ReportService } from './report.service'
import {
  EmployeeBookingBreakdownType,
  EquipmentUsageType,
  MonthlyBookingStatType,
  MostBookedRoomType,
  REPORT_STATUS_ENUM,
} from './report.types'

@Resolver()
export class ReportResolver {
  private readonly service = new ReportService()

  @Query(() => [MostBookedRoomType])
  @Authorized('report:read')
  async mostBookedRooms(
    @Ctx() context: GraphQLContext,
    @Arg('range', () => ReportRangeInput) range: ReportRangeInput,
    @Arg('limit', () => Int, { nullable: true }) limit: number | null | undefined,
  ): Promise<MostBookedRoomType[]> {
    const rows = await this.service.mostBookedRooms(context.dataSource.manager, range, limit)
    return rows.map((row) => ({ ...row }))
  }

  @Query(() => [EmployeeBookingBreakdownType])
  @Authorized('report:read')
  async bookingsPerEmployee(
    @Ctx() context: GraphQLContext,
    @Arg('range', () => ReportRangeInput, { nullable: true }) range: ReportRangeInput | null,
    @Arg('limit', () => Int, { nullable: true }) limit: number | null | undefined,
  ): Promise<EmployeeBookingBreakdownType[]> {
    const rows = await this.service.bookingsPerEmployee(context.dataSource.manager, range, limit)
    return rows.map((row) => ({ ...row }))
  }

  @Query(() => [EquipmentUsageType])
  @Authorized('report:read')
  async equipmentUsage(
    @Ctx() context: GraphQLContext,
    @Arg('range', () => ReportRangeInput) range: ReportRangeInput,
    @Arg('statuses', () => [REPORT_STATUS_ENUM], { nullable: true }) statuses: BookingStatus[] | null,
    @Arg('limit', () => Int, { nullable: true }) limit: number | null | undefined,
  ): Promise<EquipmentUsageType[]> {
    const rows = await this.service.equipmentUsage(context.dataSource.manager, range, statuses, limit)
    return rows.map((row) => ({ ...row }))
  }

  @Query(() => [MonthlyBookingStatType])
  @Authorized('report:read')
  async monthlyBookingStatistics(
    @Ctx() context: GraphQLContext,
    @Arg('range', () => ReportRangeInput, { nullable: true }) range: ReportRangeInput | null,
    @Arg('limit', () => Int, { nullable: true }) limit: number | null | undefined,
  ): Promise<MonthlyBookingStatType[]> {
    const rows = await this.service.monthlyBookingStatistics(context.dataSource.manager, range, limit)
    return rows.map((row) => ({ ...row }))
  }
}
