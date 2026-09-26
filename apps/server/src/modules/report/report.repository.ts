import type { EntityManager } from 'typeorm'
import { BOOKING_STATUSES, type BookingStatus } from '@resource-booking/shared'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../common/pagination/page-args'
import { DELETED_USER_DISPLAY_NAME } from '../../loaders/employee.loader'
import { AuditLog } from '../audit/audit-log.entity'
import { Booking } from '../booking/booking.entity'
import { BookingEquipment } from '../booking/booking-equipment.entity'
import { Employee } from '../employee/employee.entity'

export interface ReportDateRange {
  from: Date
  to: Date
}

export interface MostBookedRoomRow {
  roomId: string
  roomName: string
  location: string
  capacity: number
  bookingCount: number
}

export interface EmployeeBookingBreakdownRow {
  employeeId: string | null
  displayName: string
  email: string | null
  totalCount: number
  pendingCount: number
  approvedCount: number
  rejectedCount: number
  cancelledCount: number
  completedCount: number
}

export interface EquipmentUsageRow {
  equipmentId: string
  equipmentName: string
  quantityAvailable: number
  bookingCount: number
  totalQuantityCommitted: number
  totalQuantityHours: number
}

export interface MonthlyBookingStatRow {
  month: string
  created: number
  approved: number
  rejected: number
  cancelled: number
}

/**
 * FR-68's "committed" has exactly one meaning in this codebase: the quantity a
 * booking holds against an item, which per FR-35 is PENDING + APPROVED only.
 * A REJECTED, CANCELLED or COMPLETED booking commits nothing, so it is excluded
 * from the default figure. The caller can widen the window per query.
 */
export const COMMITTED_BOOKING_STATUSES: readonly BookingStatus[] = ['PENDING', 'APPROVED']

const DELETED_USER_SQL_LITERAL = `'${DELETED_USER_DISPLAY_NAME.replace(/'/g, "''")}'`

/** NFR-2: a report row set is still a collection, so every report is bounded. */
function resolveLimit(limit: number | null | undefined): number {
  const raw = limit === null || limit === undefined || !Number.isFinite(limit) ? DEFAULT_PAGE_SIZE : Math.trunc(limit)
  return Math.min(MAX_PAGE_SIZE, Math.max(1, raw))
}

function statusCountField(status: BookingStatus): string {
  return `CAST(COUNT(b.id) FILTER (WHERE b.status = '${status}') AS int)`
}

/**
 * FR-66–70: every report is one aggregated SQL statement. The application layer
 * only ever receives rows that are already grouped and counted — never booking
 * rows to be summed or counted in JS.
 */
export class ReportRepository {
  /** FR-66 — rooms ranked by booking count over a selected date range. */
  async mostBookedRooms(
    manager: EntityManager,
    range: ReportDateRange,
    limit: number | null | undefined,
  ): Promise<MostBookedRoomRow[]> {
    return manager
      .getRepository(Booking)
      .createQueryBuilder('b')
      .innerJoin('b.room', 'room')
      .select('room.id', 'roomId')
      .addSelect('room.name', 'roomName')
      .addSelect('room.location', 'location')
      .addSelect('room.capacity', 'capacity')
      .addSelect('CAST(COUNT(b.id) AS int)', 'bookingCount')
      .where('b.start_time < :to', { to: range.to })
      .andWhere('b.end_time > :from', { from: range.from })
      .groupBy('room.id')
      .addGroupBy('room.name')
      .addGroupBy('room.location')
      .addGroupBy('room.capacity')
      .orderBy('"bookingCount"', 'DESC')
      .addOrderBy('room.name', 'ASC')
      .limit(resolveLimit(limit))
      .getRawMany<MostBookedRoomRow>()
  }

  /**
   * FR-67 — booking counts by employee broken down by final status, one column
   * per status via conditional aggregation. Grouped on `booking.employee_id`
   * (nullable per FR-7), so a requester whose employee row was hard-deleted
   * still reports under the "Deleted user" fallback.
   */
  async bookingsPerEmployee(
    manager: EntityManager,
    range: ReportDateRange | null,
    limit: number | null | undefined,
  ): Promise<EmployeeBookingBreakdownRow[]> {
    const qb = manager
      .getRepository(Booking)
      .createQueryBuilder('b')
      .leftJoin(Employee, 'emp', 'emp.id = b.employee_id')
      .select('b.employee_id', 'employeeId')
      .addSelect(
        `COALESCE(NULLIF(BTRIM(CONCAT(emp.first_name, ' ', emp.last_name)), ''), ${DELETED_USER_SQL_LITERAL})`,
        'displayName',
      )
      .addSelect('emp.email', 'email')
      .addSelect('CAST(COUNT(b.id) AS int)', 'totalCount')

    for (const status of BOOKING_STATUSES) {
      qb.addSelect(statusCountField(status), `${status.toLowerCase()}Count`)
    }

    if (range !== null) {
      qb.where('b.start_time < :to', { to: range.to }).andWhere('b.end_time > :from', { from: range.from })
    }

    return qb
      .groupBy('b.employee_id')
      .addGroupBy('emp.first_name')
      .addGroupBy('emp.last_name')
      .addGroupBy('emp.email')
      .orderBy('"totalCount"', 'DESC')
      .addOrderBy('emp.last_name', 'ASC')
      .addOrderBy('emp.first_name', 'ASC')
      .limit(resolveLimit(limit))
      .getRawMany<EmployeeBookingBreakdownRow>()
  }

  /**
   * FR-68 — quantity-hours committed per equipment item. Both the multiplication
   * and the duration live in SQL: each booking line contributes
   * `quantity * (overlap between its window and the selected range, in hours)`,
   * clipped with LEAST/GREATEST so a booking straddling a range boundary
   * contributes only the hours inside it.
   */
  async equipmentUsage(
    manager: EntityManager,
    range: ReportDateRange,
    statuses: readonly BookingStatus[],
    limit: number | null | undefined,
  ): Promise<EquipmentUsageRow[]> {
    return manager
      .getRepository(BookingEquipment)
      .createQueryBuilder('be')
      .innerJoin('be.booking', 'b')
      .innerJoin('be.equipment', 'e')
      .select('e.id', 'equipmentId')
      .addSelect('e.name', 'equipmentName')
      .addSelect('e.quantity_available', 'quantityAvailable')
      .addSelect('CAST(COUNT(DISTINCT b.id) AS int)', 'bookingCount')
      .addSelect('CAST(SUM(be.quantity) AS int)', 'totalQuantityCommitted')
      .addSelect(
        `CAST(ROUND(CAST(SUM(be.quantity * (EXTRACT(EPOCH FROM (LEAST(b.end_time, :to) - GREATEST(b.start_time, :from))) / 3600.0)) AS numeric), 2) AS double precision)`,
        'totalQuantityHours',
      )
      .where('b.start_time < :to', { to: range.to })
      .andWhere('b.end_time > :from', { from: range.from })
      .andWhere('b.status IN (:...statuses)', { statuses: [...statuses] })
      .groupBy('e.id')
      .addGroupBy('e.name')
      .addGroupBy('e.quantity_available')
      .orderBy('"totalQuantityHours"', 'DESC')
      .addOrderBy('e.name', 'ASC')
      .limit(resolveLimit(limit))
      .getRawMany<EquipmentUsageRow>()
  }

  /**
   * FR-69 — bookings created / approved / rejected / cancelled per month.
   *
   * "Created" is bucketed on `booking.created_at`; the three outcome counts are
   * bucketed on `audit_log.created_at`, because FR-40/FR-46 already define a
   * booking's processed date as the audit entry's timestamp (there is no
   * `processed_at` column, §6). Two `UNION ALL` arms therefore have to be
   * merged on the month key — the outer `GROUP BY month` over `SUM()` does
   * that inside the database, so a month with creations but no decisions (or
   * the reverse) still returns one row with zeros rather than two rows.
   */
  async monthlyBookingStatistics(
    manager: EntityManager,
    range: ReportDateRange | null,
    limit: number | null | undefined,
  ): Promise<MonthlyBookingStatRow[]> {
    const bookingTable = manager.getRepository(Booking).metadata.tableName
    const auditTable = manager.getRepository(AuditLog).metadata.tableName

    const createdFilters: string[] = []
    const decidedFilters: string[] = []
    if (range !== null) {
      createdFilters.push('"created_at" >= :fromDate', '"created_at" < :toDate')
      decidedFilters.push('"created_at" >= :fromDate', '"created_at" < :toDate')
    }

    // Written without table aliases or `alias.column` references: this fragment is
    // inlined as a derived table, and an alias-qualified name inside it would be
    // rewritten by the outer builder's property replacement (the outer query has
    // no metadata for the arms' tables). Quoted snake_case names need no alias.
    const unionArms = `
SELECT
  TO_CHAR(DATE_TRUNC('month', "created_at"), 'YYYY-MM') AS month,
  CAST(COUNT(*) AS int) AS created,
  CAST(0 AS int) AS approved,
  CAST(0 AS int) AS rejected,
  CAST(0 AS int) AS cancelled
FROM ${bookingTable}
${createdFilters.length > 0 ? `WHERE ${createdFilters.join(' AND ')}` : ''}
GROUP BY DATE_TRUNC('month', "created_at")
UNION ALL
SELECT
  TO_CHAR(DATE_TRUNC('month', "created_at"), 'YYYY-MM') AS month,
  CAST(0 AS int) AS created,
  CAST(COUNT(*) FILTER (WHERE "action" = 'APPROVE') AS int) AS approved,
  CAST(COUNT(*) FILTER (WHERE "action" = 'REJECT') AS int) AS rejected,
  CAST(COUNT(*) FILTER (WHERE "action" = 'CANCEL') AS int) AS cancelled
FROM ${auditTable}
${decidedFilters.length > 0 ? `WHERE ${decidedFilters.join(' AND ')}` : ''}
GROUP BY DATE_TRUNC('month', "created_at")`

    const qb = manager
      .createQueryBuilder()
      .select('u.month', 'month')
      .addSelect('CAST(SUM(u.created) AS int)', 'created')
      .addSelect('CAST(SUM(u.approved) AS int)', 'approved')
      .addSelect('CAST(SUM(u.rejected) AS int)', 'rejected')
      .addSelect('CAST(SUM(u.cancelled) AS int)', 'cancelled')
      .from(`(${unionArms})`, 'u')
      .groupBy('u.month')
      .orderBy('u.month', 'ASC')
      .limit(resolveLimit(limit))

    if (range !== null) {
      qb.setParameter('fromDate', range.from).setParameter('toDate', range.to)
    }

    return qb.getRawMany<MonthlyBookingStatRow>()
  }
}
