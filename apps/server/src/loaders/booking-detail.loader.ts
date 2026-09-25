import DataLoader from 'dataloader'
import { In, type DataSource } from 'typeorm'
import type { BookingStatus } from '@resource-booking/shared'
import { AuditLog } from '../modules/audit/audit-log.entity'
import { Booking } from '../modules/booking/booking.entity'
import { BookingEquipment } from '../modules/booking/booking-equipment.entity'
import type { BookingReadScope } from '../modules/booking/booking.repository'
import {
  equipmentAvailabilityKey,
  getEquipmentFreeQuantities,
  type EquipmentAvailabilityWindow,
} from '../modules/booking/availability'
import { MeetingRoom } from '../modules/room/room.entity'

export type BookingSummaryData = Pick<
  Booking,
  'id' | 'startTime' | 'endTime' | 'purpose' | 'status'
>

export type RecentEmployeeBookingsKey = {
  employeeId: string
  excludeBookingId: string
  scope: BookingReadScope
}

export type OverlappingRoomBookingsKey = {
  bookingId: string
  roomId: string
  startTime: Date
  endTime: Date
  scope: BookingReadScope
}

type BookingSummaryRow = {
  id: string
  startTime: Date
  endTime: Date
  purpose: string
  status: BookingStatus
}

type OverlappingBookingSummaryRow = BookingSummaryRow & {
  roomId: string
  employeeId: string | null
}

function scopeKey(scope: BookingReadScope): string {
  return scope.kind === 'all' ? 'all' : `own:${scope.employeeId}`
}

function groupValues<TKey, TValue>(keys: readonly TKey[], values: TValue[], keyOf: (value: TValue) => TKey): Map<TKey, TValue[]> {
  const grouped = new Map<TKey, TValue[]>()
  for (const key of keys) {
    grouped.set(key, [])
  }
  for (const value of values) {
    grouped.get(keyOf(value))?.push(value)
  }
  return grouped
}

export function createBookingStatusHistoryLoader(
  dataSource: DataSource,
): DataLoader<string, AuditLog[]> {
  return new DataLoader(async (bookingIds) => {
    const ids = [...new Set(bookingIds)]
    const history = await dataSource.getRepository(AuditLog).find({
      where: { bookingId: In(ids) },
      order: { bookingId: 'ASC', createdAt: 'ASC', id: 'ASC' },
    })
    const grouped = groupValues(ids, history, (entry) => entry.bookingId)
    return ids.map((bookingId) => grouped.get(bookingId) ?? [])
  })
}

export function createBookingRoomLoader(
  dataSource: DataSource,
): DataLoader<string, MeetingRoom | null> {
  return new DataLoader(async (roomIds) => {
    const ids = [...new Set(roomIds)]
    const rooms = await dataSource.getRepository(MeetingRoom).find({
      where: { id: In(ids) },
      order: { id: 'ASC' },
    })
    const byId = new Map(rooms.map((room) => [room.id, room]))
    return ids.map((roomId) => byId.get(roomId) ?? null)
  })
}

export function createBookingEquipmentLinesLoader(
  dataSource: DataSource,
): DataLoader<string, BookingEquipment[]> {
  return new DataLoader(async (bookingIds) => {
    const ids = [...new Set(bookingIds)]
    const lines = await dataSource.getRepository(BookingEquipment).find({
      where: { bookingId: In(ids) },
      relations: { equipment: true },
      order: { bookingId: 'ASC', equipmentId: 'ASC', id: 'ASC' },
    })
    const grouped = groupValues(ids, lines, (line) => line.bookingId)
    return ids.map((bookingId) => grouped.get(bookingId) ?? [])
  })
}

export function createRecentEmployeeBookingsLoader(
  dataSource: DataSource,
): DataLoader<RecentEmployeeBookingsKey, BookingSummaryData[]> {
  return new DataLoader(
    async (keys) => {
      if (keys.length === 0) {
        return []
      }
      const parameters: string[] = []
      const addParameter = (value: string): string => {
        parameters.push(value)
        return `$${parameters.length}`
      }
      const requests = keys.map((key, index) => {
        const employeeParameter = addParameter(key.employeeId)
        const excludeParameter = addParameter(key.excludeBookingId)
        const scopeParameter =
          key.scope.kind === 'own' ? `${addParameter(key.scope.employeeId)}::uuid` : 'NULL::uuid'
        return `(${index}, ${employeeParameter}::uuid, ${excludeParameter}::uuid, ${scopeParameter})`
      })
      const rows = await dataSource.query<Array<BookingSummaryRow & { requestIndex: number }>>(
        `
           WITH requested(request_index, employee_id, exclude_booking_id, scope_employee_id) AS (
             SELECT request_index::integer, employee_id::uuid, exclude_booking_id::uuid, scope_employee_id::uuid
             FROM (VALUES ${requests.join(', ')}) AS values_rows(request_index, employee_id, exclude_booking_id, scope_employee_id)
           ),
          ranked AS (
            SELECT
              requested.request_index,
               booking.id,
               booking.created_at AS created_at,
               booking.start_time AS start_time,
              booking.end_time AS end_time,
              booking.purpose,
              booking.status,
              ROW_NUMBER() OVER (
                PARTITION BY requested.request_index
                ORDER BY booking.created_at DESC, booking.id DESC
              ) AS recent_rank
            FROM requested
            INNER JOIN booking
              ON booking.employee_id = requested.employee_id
              AND booking.id <> requested.exclude_booking_id
             WHERE (requested.scope_employee_id IS NULL OR booking.employee_id = requested.scope_employee_id)
           )
          SELECT
            request_index AS "requestIndex",
            id,
            start_time AS "startTime",
            end_time AS "endTime",
            purpose,
            status
          FROM ranked
          WHERE recent_rank <= 5
           ORDER BY request_index ASC, created_at DESC, id DESC
         `,
        parameters,
      )
      const grouped = new Map<number, BookingSummaryData[]>()
      for (const row of rows) {
        const group = grouped.get(row.requestIndex) ?? []
        group.push({
          id: row.id,
          startTime: row.startTime,
          endTime: row.endTime,
          purpose: row.purpose,
          status: row.status,
        })
        grouped.set(row.requestIndex, group)
      }
      return keys.map((_key, index) => grouped.get(index) ?? [])
    },
    {
      cacheKeyFn: (key) =>
        `${key.employeeId}:${key.excludeBookingId}:${scopeKey(key.scope)}`,
    },
  )
}

export function createOverlappingRoomBookingsLoader(
  dataSource: DataSource,
): DataLoader<OverlappingRoomBookingsKey, BookingSummaryData[]> {
  return new DataLoader(
    async (keys) => {
      if (keys.length === 0) {
        return []
      }
      const parameters: Record<string, string | Date> = {}
      const clauses = keys.map((key, index) => {
        parameters[`overlapRoomId${index}`] = key.roomId
        parameters[`overlapExcludeBookingId${index}`] = key.bookingId
        parameters[`overlapEndTime${index}`] = key.endTime
        parameters[`overlapStartTime${index}`] = key.startTime
        const scopeCondition =
          key.scope.kind === 'own'
            ? `AND booking.employee_id = :overlapScopeEmployeeId${index}`
            : ''
        if (key.scope.kind === 'own') {
          parameters[`overlapScopeEmployeeId${index}`] = key.scope.employeeId
        }
        return `(
          booking.room_id = :overlapRoomId${index}
          AND booking.id <> :overlapExcludeBookingId${index}
          AND booking.start_time < :overlapEndTime${index}
          AND booking.end_time > :overlapStartTime${index}
          ${scopeCondition}
        )`
      })
      const query = dataSource
        .getRepository(Booking)
        .createQueryBuilder('booking')
        .select('booking.id', 'id')
        .addSelect('booking.start_time', 'startTime')
        .addSelect('booking.end_time', 'endTime')
        .addSelect('booking.purpose', 'purpose')
        .addSelect('booking.status', 'status')
        .addSelect('booking.room_id', 'roomId')
        .addSelect('booking.employee_id', 'employeeId')
        .where(`(${clauses.join(' OR ')})`, parameters)
        .orderBy('booking.start_time', 'ASC')
        .addOrderBy('booking.id', 'ASC')
      const rows = await query.getRawMany<OverlappingBookingSummaryRow>()
      return keys.map((key) =>
        rows.filter(
          (row) =>
            row.id !== key.bookingId &&
            row.roomId === key.roomId &&
            (key.scope.kind === 'all' || row.employeeId === key.scope.employeeId) &&
            row.startTime.getTime() < key.endTime.getTime() &&
            row.endTime.getTime() > key.startTime.getTime(),
        ),
      )
    },
    {
      cacheKeyFn: (key) =>
        `${key.bookingId}:${key.roomId}:${key.startTime.toISOString()}:${key.endTime.toISOString()}:${scopeKey(key.scope)}`,
    },
  )
}

export function createEquipmentAvailabilityLoader(
  dataSource: DataSource,
): DataLoader<EquipmentAvailabilityWindow, number> {
  return new DataLoader(
    async (windows) => {
      const quantities = await getEquipmentFreeQuantities(dataSource.manager, windows)
      return windows.map((window) => quantities.get(equipmentAvailabilityKey(window)) ?? 0)
    },
    { cacheKeyFn: equipmentAvailabilityKey },
  )
}
