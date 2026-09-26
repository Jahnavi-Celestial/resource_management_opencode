import type { BookingStatus } from '@resource-booking/shared'
import type { EntityManager, SelectQueryBuilder } from 'typeorm'
import { isUuid } from '../../common/db/uuid'
import { applyPagination, type PaginationArgs } from '../../common/pagination/apply-pagination'
import type { SortInput } from '../../common/pagination/sort-input'
import { isRoomAvailable } from '../booking/availability'
import { Booking } from './booking.entity'
import { BookingEquipment } from './booking-equipment.entity'
import { Equipment } from '../equipment/equipment.entity'
import { MeetingRoom } from '../room/room.entity'

type BookingResourceLock =
  | { kind: 'room'; id: string }
  | { kind: 'equipment'; id: string }

/** FR-74: only bookings that can still happen are worth a reminder. */
const REMINDER_STATUSES = ['PENDING', 'APPROVED'] as const

export type InsertBookingData = {
  employeeId: string | null
  roomId: string
  startTime: Date
  endTime: Date
  purpose: string
  numberOfAttendees: number
}

export type InsertBookingEquipmentData = {
  equipmentId: string
  quantity: number
}

export type BookingReadScope = { kind: 'all' } | { kind: 'own'; employeeId: string }

export type BookingListFilter = {
  search?: string | null
  status?: BookingStatus | null
  startDate?: Date | null
  endDate?: Date | null
  employeeId?: string | null
}

export type BookingPage = {
  items: Booking[]
  totalCount: number
}

const BOOKING_SORTABLE_FIELDS = {
  id: 'booking.id',
  startTime: 'booking.start_time',
  endTime: 'booking.end_time',
  purpose: 'booking.purpose',
  numberOfAttendees: 'booking.number_of_attendees',
  status: 'booking.status',
  createdAt: 'booking.created_at',
  updatedAt: 'booking.updated_at',
} as const

function applyReadScope(
  query: SelectQueryBuilder<Booking>,
  scope: BookingReadScope,
): SelectQueryBuilder<Booking> {
  if (scope.kind === 'own') {
    query.andWhere('booking.employee_id = :employeeId', { employeeId: scope.employeeId })
  }
  return query
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}

function applySearch(query: SelectQueryBuilder<Booking>, search: string): SelectQueryBuilder<Booking> {
  const pattern = `%${escapeLike(search.toLocaleLowerCase())}%`
  return query.andWhere(
    `(
      EXISTS (
        SELECT 1
        FROM employee booking_requester
        WHERE booking_requester.id = booking.employee_id
          AND (
            LOWER(booking_requester.first_name) LIKE :search
            OR LOWER(booking_requester.last_name) LIKE :search
          )
      )
      OR EXISTS (
        SELECT 1
        FROM meeting_room booking_room
        WHERE booking_room.id = booking.room_id
          AND LOWER(booking_room.name) LIKE :search
      )
      OR EXISTS (
        SELECT 1
        FROM booking_equipment search_booking_equipment
        INNER JOIN equipment search_equipment
          ON search_equipment.id = search_booking_equipment.equipment_id
        WHERE search_booking_equipment.booking_id = booking.id
          AND LOWER(search_equipment.name) LIKE :search
      )
      OR LOWER(booking.purpose) LIKE :search
      OR LOWER(CAST(booking.status AS TEXT)) LIKE :search
    )`,
    { search: pattern },
  )
}

function applyFilter(
  query: SelectQueryBuilder<Booking>,
  filter: BookingListFilter | null | undefined,
): SelectQueryBuilder<Booking> {
  if (filter?.search?.trim()) {
    applySearch(query, filter.search.trim())
  }
  if (filter?.status) {
    query.andWhere('booking.status = :status', { status: filter.status })
  }
  if (filter?.startDate) {
    query.andWhere('booking.start_time >= :startDate', { startDate: filter.startDate })
  }
  if (filter?.endDate) {
    query.andWhere('booking.start_time <= :endDate', { endDate: filter.endDate })
  }
  return query
}

export type BookingSummaryData = {
  id: string
  startTime: Date
  endTime: Date
  purpose: string
  status: string
}

export class BookingRepository {
  async findPage(
    manager: EntityManager,
    scope: BookingReadScope,
    pagination: PaginationArgs,
    sort: SortInput | null | undefined,
    filter: BookingListFilter | null | undefined,
  ): Promise<BookingPage> {
    const query = manager.getRepository(Booking).createQueryBuilder('booking')
    applyReadScope(query, scope)
    applyFilter(query, filter)
    applyPagination(query, pagination, sort, BOOKING_SORTABLE_FIELDS)
    query.addOrderBy('booking.id', 'ASC')
    const [items, totalCount] = await query.getManyAndCount()
    return { items, totalCount }
  }

  async findVisibleById(
    manager: EntityManager,
    bookingId: string,
    scope: BookingReadScope,
  ): Promise<Booking | null> {
    if (!isUuid(bookingId)) {
      return null
    }
    const query = manager.getRepository(Booking).createQueryBuilder('booking')
    query.where('booking.id = :bookingId', { bookingId })
    return applyReadScope(query, scope).getOne()
  }

  async findRoomAvailability(
    manager: EntityManager,
    roomId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<BookingSummaryData[]> {
    const available = await isRoomAvailable(manager, roomId, startDate, endDate)
    if (available) return []
    const query = manager.getRepository(Booking).createQueryBuilder('booking')
    query.where('booking.roomId = :roomId', { roomId })
    query.andWhere('booking.status IN (:...statuses)', { statuses: ['PENDING', 'APPROVED'] })
    query.andWhere('booking.start_time < :endDate', { endDate })
    query.andWhere('booking.end_time > :startDate', { startDate })
    query.orderBy('booking.start_time', 'ASC')
    const rows = await query.getMany()
    return rows.map((b) => ({
      id: b.id,
      startTime: b.startTime,
      endTime: b.endTime,
      purpose: b.purpose,
      status: b.status,
    }))
  }

  async lockResources(
    manager: EntityManager,
    roomId: string,
    equipmentIds: readonly string[],
  ): Promise<void> {
    const resources = new Map<string, BookingResourceLock>()
    resources.set(`room:${roomId}`, { kind: 'room', id: roomId })

    for (const equipmentId of equipmentIds) {
      resources.set(`equipment:${equipmentId}`, { kind: 'equipment', id: equipmentId })
    }

    const sortedResources = [...resources.values()].sort((left, right) => {
      if (left.id !== right.id) {
        return left.id < right.id ? -1 : 1
      }
      return left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0
    })

    for (const resource of sortedResources) {
      if (resource.kind === 'room') {
        await manager
          .getRepository(MeetingRoom)
          .createQueryBuilder('room')
          .select('room.id')
          .where('room.id = :id', { id: resource.id })
          .orderBy('room.id', 'ASC')
          .setLock('pessimistic_write')
          .getOne()
      } else {
        await manager
          .getRepository(Equipment)
          .createQueryBuilder('equipment')
          .select('equipment.id')
          .where('equipment.id = :id', { id: resource.id })
          .orderBy('equipment.id', 'ASC')
          .setLock('pessimistic_write')
          .getOne()
      }
    }
  }

  async findRoom(manager: EntityManager, roomId: string): Promise<MeetingRoom | null> {
    return manager.getRepository(MeetingRoom).findOne({ where: { id: roomId } })
  }

  async findForUpdate(manager: EntityManager, bookingId: string): Promise<Booking | null> {
    return manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .where('booking.id = :bookingId', { bookingId })
      .setLock('pessimistic_write')
      .getOne()
  }

  async updateStatus(
    manager: EntityManager,
    booking: Booking,
    status: Booking['status'],
  ): Promise<Booking> {
    booking.status = status
    return manager.getRepository(Booking).save(booking)
  }

  async insert(manager: EntityManager, data: InsertBookingData): Promise<Booking> {
    const repository = manager.getRepository(Booking)
    return repository.save(
      repository.create({
        ...data,
        rejectionReason: null,
        status: 'PENDING',
      }),
    )
  }

  async insertEquipment(
    manager: EntityManager,
    bookingId: string,
    items: readonly InsertBookingEquipmentData[],
  ): Promise<BookingEquipment[]> {
    if (items.length === 0) {
      return []
    }

    const repository = manager.getRepository(BookingEquipment)
    return repository.save(
      items.map((item) =>
        repository.create({
          bookingId,
          equipmentId: item.equipmentId,
          quantity: item.quantity,
        }),
      ),
    )
  }

  async findPendingOrdered(manager: EntityManager, pagination: PaginationArgs, sort: SortInput | null | undefined): Promise<BookingPage> {
    const query = manager.getRepository(Booking).createQueryBuilder('booking')
    query.where('booking.status = :status', { status: 'PENDING' })
    applyPagination(query, pagination, sort, BOOKING_SORTABLE_FIELDS)
    query.addOrderBy('booking.id', 'ASC')
    const [items, totalCount] = await query.getManyAndCount()
    return { items, totalCount }
  }

  async findBookingEquipment(manager: EntityManager, bookingId: string): Promise<BookingEquipment[]> {
    return manager.getRepository(BookingEquipment).find({ where: { bookingId } })
  }

  /**
   * FR-74/75: the reminder job's candidate set — PENDING/APPROVED bookings that
   * have not started yet and start within the lead-time window, minus any
   * booking that already has a REMINDER notification.
   *
   * Two deliberate choices:
   *
   * - **Status is restricted to PENDING/APPROVED.** A reminder for a booking that
   *   will never happen is worse than no reminder.
   * - **The FR-75 `NOT EXISTS` lives here, in SQL.** Checking per booking in the
   *   job would mean one extra round-trip per candidate on every run, forever,
   *   for the (overwhelmingly common) already-reminded booking. Pushing it into
   *   the scan turns the idempotency check into an index lookup. It is a
   *   *pre-filter*, not the decision: `NotificationRepository.hasReminder` is
   *   re-checked inside the write transaction, because this query runs outside
   *   one and two overlapping runs could otherwise both pass it.
   *
   * `employee_id IS NOT NULL` is deliberately *not* filtered here — a booking
   * whose requester was hard-deleted (FR-7) still enters the scan and is counted
   * as `skippedNoRecipient` by the job, so the FR-7 edge case is visible in the
   * summary instead of silently shrinking the candidate set.
   */
  async findStartingWithinLeadTime(
    manager: EntityManager,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<Booking[]> {
    return manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .where('booking.status IN (:...reminderStatuses)', { reminderStatuses: [...REMINDER_STATUSES] })
      .andWhere('booking.start_time > :from', { from })
      .andWhere('booking.start_time <= :to', { to })
      .andWhere(
        `NOT EXISTS (
          SELECT 1
          FROM notification reminder_check
          WHERE reminder_check.booking_id = booking.id
            AND reminder_check.type = 'REMINDER'
        )`,
      )
      .orderBy('booking.start_time', 'ASC')
      .addOrderBy('booking.id', 'ASC')
      .take(limit)
      .getMany()
  }

  /**
   * FR-72: the FR-72 job's candidate set — APPROVED bookings whose end time has
   * already elapsed. Ordered by `end_time` (then id, for a stable page) so a
   * bounded batch always drains the oldest elapsed bookings first and a run that
   * hits its limit leaves the rest for the next run.
   *
   * Deliberately a *pre-filter*, not the decision: the job re-checks status and
   * end time inside the per-booking transaction while holding `FOR UPDATE`, so a
   * booking cancelled or completed by someone else in between is never completed
   * twice.
   */
  async findElapsedApproved(
    manager: EntityManager,
    now: Date,
    limit: number,
  ): Promise<Booking[]> {
    return manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .where('booking.status = :status', { status: 'APPROVED' })
      .andWhere('booking.end_time < :now', { now })
      .orderBy('booking.end_time', 'ASC')
      .addOrderBy('booking.id', 'ASC')
      .take(limit)
      .getMany()
  }
}
