import type { EntityManager } from 'typeorm'
import { BOOKING_STATUSES, type BookingStatus } from '@resource-booking/shared'
import { DomainError } from '../../common/errors/domain-error'
import {
  COMMITTED_BOOKING_STATUSES,
  ReportRepository,
  type EmployeeBookingBreakdownRow,
  type EquipmentUsageRow,
  type MonthlyBookingStatRow,
  type MostBookedRoomRow,
  type ReportDateRange,
} from './report.repository'
import type { ReportRangeInput } from './report.inputs'

function toRange(input: ReportRangeInput): ReportDateRange {
  const from = input.from instanceof Date ? input.from : new Date(input.from)
  const to = input.to instanceof Date ? input.to : new Date(input.to)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new DomainError('Invalid report date range')
  }
  if (from.getTime() >= to.getTime()) {
    throw new DomainError('Report range "from" must be strictly before "to"')
  }
  return { from, to }
}

function toOptionalRange(input: ReportRangeInput | null | undefined): ReportDateRange | null {
  return input === null || input === undefined ? null : toRange(input)
}

function toStatuses(statuses: readonly BookingStatus[] | null | undefined): BookingStatus[] {
  if (statuses === null || statuses === undefined) {
    return [...COMMITTED_BOOKING_STATUSES]
  }
  const invalid = statuses.filter((status) => !BOOKING_STATUSES.includes(status))
  if (invalid.length > 0 || statuses.length === 0) {
    throw new DomainError(`Invalid booking status filter: ${invalid.join(', ') || 'empty list'}`)
  }
  return [...statuses]
}

/**
 * FR-66–70, read-only. No transaction is opened: a report opens no transaction
 * because it mutates nothing, and the aggregation happens in SQL (FR-70).
 */
export class ReportService {
  private readonly repository: ReportRepository

  constructor(repository = new ReportRepository()) {
    this.repository = repository
  }

  async mostBookedRooms(
    manager: EntityManager,
    range: ReportRangeInput,
    limit: number | null | undefined,
  ): Promise<MostBookedRoomRow[]> {
    return this.repository.mostBookedRooms(manager, toRange(range), limit)
  }

  async bookingsPerEmployee(
    manager: EntityManager,
    range: ReportRangeInput | null | undefined,
    limit: number | null | undefined,
  ): Promise<EmployeeBookingBreakdownRow[]> {
    return this.repository.bookingsPerEmployee(manager, toOptionalRange(range), limit)
  }

  async equipmentUsage(
    manager: EntityManager,
    range: ReportRangeInput,
    statuses: readonly BookingStatus[] | null | undefined,
    limit: number | null | undefined,
  ): Promise<EquipmentUsageRow[]> {
    return this.repository.equipmentUsage(manager, toRange(range), toStatuses(statuses), limit)
  }

  async monthlyBookingStatistics(
    manager: EntityManager,
    range: ReportRangeInput | null | undefined,
    limit: number | null | undefined,
  ): Promise<MonthlyBookingStatRow[]> {
    return this.repository.monthlyBookingStatistics(manager, toOptionalRange(range), limit)
  }
}
