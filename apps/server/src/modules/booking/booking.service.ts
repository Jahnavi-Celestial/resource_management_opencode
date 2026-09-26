import type { DataSource, EntityManager } from 'typeorm'
import { AuditService } from '../audit/audit.service'
import type { AuditAction } from '../audit/audit-log.entity'
import { DomainError } from '../../common/errors/domain-error'
import { ConflictError } from '../../common/errors/conflict-error'
import { NotFoundError } from '../../common/errors/not-found-error'
import { InputValidationError } from '../../common/errors/field-errors'
import { runInTransaction, type TransactionalEntityManager } from '../../common/db/transaction'
import { isRoomAvailable, getEquipmentFreeQuantity } from './availability'
import { Booking } from './booking.entity'
import { BookingEquipment } from './booking-equipment.entity'
import { validateCreateBookingInput, type CreateBookingInput } from './booking.inputs'
import {
  BookingRepository,
  type BookingListFilter,
  type BookingPage,
  type BookingReadScope,
} from './booking.repository'
import { NotificationService, type BookingDecisionType, type BookingNotificationDetails } from '../notification/notification.service'
import type { NotificationRecordType } from '../notification/notification.types'
import { EmailService } from '../../email/email.service'
import type { EmailTemplate } from '../../email/email.types'
import type { PaginationArgs } from '../../common/pagination/apply-pagination'
import type { SortInput } from '../../common/pagination/sort-input'
import { loadEnv } from '../../config/env'

/**
 * Which decision, if any, produces a transactional email (FR-61).
 *
 * FR-61 names exactly three events: approval, rejection and the upcoming-booking
 * reminder. A cancellation is not one of them, so it maps to `null` and gets no
 * mail at all — the requester still gets the in-app `BOOKING_CANCELLED`
 * notification, which is the whole of what FR-57 requires of a cancellation.
 *
 * The mapping is spelled out as an exhaustive `Record` rather than a ternary on
 * purpose: a `Record<BookingDecisionType, ...>` fails to compile the moment a
 * fourth decision type is added, so a new decision can never silently inherit
 * the rejection template and send a requester a "your booking was rejected"
 * mail for something that was not a rejection.
 */
const DECISION_EMAIL_TEMPLATE: Record<BookingDecisionType, EmailTemplate | null> = {
  BOOKING_APPROVED: 'BOOKING_APPROVED',
  BOOKING_REJECTED: 'BOOKING_REJECTED',
  BOOKING_CANCELLED: null,
}

export class BookingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly repository: BookingRepository = new BookingRepository(),
    private readonly auditService: AuditService = new AuditService(),
    private readonly notificationService: NotificationService = new NotificationService(),
    private readonly emailService: EmailService = new EmailService(),
  ) {}

  async list(
    scope: BookingReadScope,
    pagination: PaginationArgs,
    sort: SortInput | null | undefined,
    filter: BookingListFilter | null | undefined,
  ): Promise<BookingPage> {
    return this.repository.findPage(this.dataSource.manager, scope, pagination, sort, filter)
  }

  async getVisibleById(bookingId: string, scope: BookingReadScope): Promise<Booking | null> {
    return this.repository.findVisibleById(this.dataSource.manager, bookingId, scope)
  }

  private notificationDetails(booking: Booking, reason?: string): BookingNotificationDetails {
    return {
      bookingId: booking.id,
      purpose: booking.purpose,
      startTime: booking.startTime,
      endTime: booking.endTime,
      ...(reason === undefined ? {} : { reason }),
    }
  }

  /**
   * Registers a post-commit notification write (FR-90). The write runs in its
   * own transaction once the booking transaction commits, then the freshly
   * created rows are pushed to the recipient's live sockets. Nothing here can
   * fail the booking: the booking is already committed, and a broken
   * notification or realtime path is logged and swallowed.
   */
  private notifyAfterCommit(
    tx: TransactionalEntityManager,
    write: (manager: EntityManager) => Promise<readonly NotificationRecordType[]>,
  ): void {
    tx.afterCommit(async () => {
      try {
        const created = await runInTransaction(this.dataSource, write)
        await this.notificationService.emitCreated(this.dataSource.manager, created)
      } catch (error: unknown) {
        console.error('[booking] post-commit notification write failed', error)
      }
    })
  }

  private notifyRequesterOfDecision(
    tx: TransactionalEntityManager,
    requesterId: string | null,
    actorId: string,
    type: BookingDecisionType,
    booking: Booking,
    reason?: string,
  ): void {
    if (requesterId === null || requesterId === actorId) {
      return
    }
    this.notifyAfterCommit(tx, async (manager) => [
      await this.notificationService.notifyRequesterOfDecision(
        manager,
        requesterId,
        type,
        this.notificationDetails(booking, reason),
      ),
    ])
    this.enqueueDecisionEmail(tx, requesterId, type, booking, reason)
  }

  /**
   * FR-61: the requester also gets a transactional email for a decision.
   *
   * Deliberately a second `afterCommit` registration rather than part of the
   * notification write: the outbox row and the notification row have
   * independent fates (the email can fail and be retried for hours), and one
   * failing must not suppress the other. The row is written inside the
   * post-commit transaction, so it lands only once the booking is durable, and
   * the dispatcher sends it later.
   *
   * A decision with no email (a cancellation, per `DECISION_EMAIL_TEMPLATE`)
   * returns before registering the hook, so no post-commit transaction is even
   * opened for it.
   */
  private enqueueDecisionEmail(
    tx: TransactionalEntityManager,
    requesterId: string,
    type: BookingDecisionType,
    booking: Booking,
    reason?: string,
  ): void {
    const template = DECISION_EMAIL_TEMPLATE[type]
    if (template === null) {
      return
    }
    tx.afterCommit(async () => {
      try {
        await runInTransaction(this.dataSource, async (manager) => {
          if (template === 'BOOKING_REJECTED' && reason === undefined) {
            // Rejections always carry a reason (validated at the input layer);
            // bail out rather than queue a rejection with no explanation. This
            // guard is scoped to rejections on purpose — it is not, and must not
            // become, the mechanism that suppresses cancellation emails.
            return null
          }
          const room = await this.repository.findRoom(manager, booking.roomId)
          return this.emailService.enqueueForEmployee(manager, requesterId, template, {
            purpose: booking.purpose,
            roomName: room?.name ?? 'a room',
            startTime: booking.startTime.toISOString(),
            endTime: booking.endTime.toISOString(),
            ...(reason === undefined ? {} : { reason }),
          })
        })
      } catch (error: unknown) {
        console.error('[booking] post-commit email enqueue failed', error)
      }
    })
  }

  async createBooking(employeeId: string, input: CreateBookingInput): Promise<Booking>
  async createBooking(input: CreateBookingInput, employeeId: string): Promise<Booking>
  async createBooking(
    first: string | CreateBookingInput,
    second: string | CreateBookingInput,
  ): Promise<Booking> {
    const employeeId = typeof first === 'string' ? first : (second as string)
    const input = typeof first === 'string' ? (second as CreateBookingInput) : first
    const validatedInput = await validateCreateBookingInput(input)

    if (typeof employeeId !== 'string' || employeeId.length === 0) {
      throw new DomainError('An authenticated employee is required')
    }

    return runInTransaction(this.dataSource, async (manager) => {
      const startTime = new Date(validatedInput.startTime)
      const endTime = new Date(validatedInput.endTime)

      if (endTime.getTime() <= startTime.getTime()) {
        throw new DomainError('Booking end time must be strictly after start time')
      }

      if (startTime.getTime() < Date.now()) {
        throw new DomainError('Booking start time must not be in the past')
      }

      await this.repository.lockResources(
        manager,
        validatedInput.roomId,
        (validatedInput.equipment ?? []).map((item) => item.equipmentId),
      )

      const room = await this.repository.findRoom(manager, validatedInput.roomId)
      if (room === null) {
        throw new NotFoundError('The selected room was not found')
      }

      if (!room.isActive) {
        throw new DomainError('The selected room is inactive')
      }

      if (validatedInput.numberOfAttendees > room.capacity) {
        throw new ConflictError(
          `Room capacity exceeded: ${validatedInput.numberOfAttendees} attendees requested for a room with capacity ${room.capacity}`,
        )
      }

      if (!(await isRoomAvailable(manager, room.id, startTime, endTime))) {
        throw new ConflictError('The selected room is not available for the requested time range')
      }

      for (const item of validatedInput.equipment ?? []) {
        const freeQuantity = await getEquipmentFreeQuantity(manager, item.equipmentId, startTime, endTime)
        if (item.quantity > freeQuantity) {
          throw new ConflictError(
            `Equipment ${item.equipmentId} is not available: requested ${item.quantity}, ${freeQuantity} free`,
          )
        }
      }

      const booking = await this.repository.insert(manager, {
        employeeId,
        roomId: room.id,
        startTime,
        endTime,
        purpose: validatedInput.purpose,
        numberOfAttendees: validatedInput.numberOfAttendees,
      })

      await this.repository.insertEquipment(manager, booking.id, validatedInput.equipment ?? [])
      await this.auditService.record(manager, {
        bookingId: booking.id,
        action: 'CREATE' as AuditAction,
        oldStatus: null,
        newStatus: 'PENDING',
        performedById: employeeId,
      })

      this.notifyAfterCommit(manager, (notificationManager) =>
        this.notificationService.notifyApprovers(notificationManager, {
          ...this.notificationDetails(booking),
          requesterId: employeeId,
        }),
      )

      return booking
    })
  }

  async cancelOwnBooking(employeeId: string, bookingId: string): Promise<Booking> {
    return this.cancelBooking(employeeId, bookingId, true)
  }

  async cancelAnyBooking(employeeId: string, bookingId: string): Promise<Booking> {
    return this.cancelBooking(employeeId, bookingId, false)
  }

  /**
   * FR-37 routing support: who requested this booking, or `null` when the
   * employee row was hard-deleted (FR-7). Deliberately not read-scope gated —
   * the caller has already proved it holds a cancel permission by the time
   * this runs, and the answer only selects which cancel rule applies; it is
   * never returned to the client. `employee_id` is immutable, so reading it
   * outside the lock below cannot race: the routed decision is the same one
   * the transaction re-checks.
   */
  async requesterIdOf(bookingId: string): Promise<string | null> {
    const requesterId = await this.repository.findRequesterId(this.dataSource.manager, bookingId)
    if (requesterId === undefined) {
      throw new NotFoundError('The booking was not found')
    }
    return requesterId
  }

  private async cancelBooking(
    employeeId: string,
    bookingId: string,
    ownBookingOnly: boolean,
  ): Promise<Booking> {
    if (typeof employeeId !== 'string' || employeeId.length === 0) {
      throw new DomainError('An authenticated employee is required')
    }

    if (typeof bookingId !== 'string' || bookingId.length === 0) {
      throw new DomainError('A booking is required')
    }

    return runInTransaction(this.dataSource, async (manager) => {
      const booking = await this.repository.findForUpdate(manager, bookingId)

      if (booking === null) {
        throw new NotFoundError('The booking was not found')
      }

      if (ownBookingOnly && booking.employeeId !== employeeId) {
        throw new DomainError('Only the booking requester can cancel this booking')
      }

      const cancellable = ownBookingOnly
        ? booking.status === 'PENDING'
        : booking.status === 'PENDING' || booking.status === 'APPROVED'

      if (!cancellable) {
        throw new DomainError(
          `Booking cannot be cancelled from its current status: ${booking.status}`,
        )
      }

      const oldStatus = booking.status
      const cancelledBooking = await this.repository.updateStatus(manager, booking, 'CANCELLED')

      await this.auditService.record(manager, {
        bookingId: cancelledBooking.id,
        action: 'CANCEL' as AuditAction,
        oldStatus,
        newStatus: 'CANCELLED',
        performedById: employeeId,
      })

      this.notifyRequesterOfDecision(
        manager,
        booking.employeeId,
        employeeId,
        'BOOKING_CANCELLED',
        cancelledBooking,
      )

      return cancelledBooking
    })
  }

  async pendingQueue(pagination: PaginationArgs, sort: SortInput | null | undefined): Promise<BookingPage> {
    return this.repository.findPendingOrdered(this.dataSource.manager, pagination, sort)
  }

  async approveBooking(managerId: string, bookingId: string): Promise<Booking> {
    if (typeof managerId !== 'string' || managerId.length === 0) {
      throw new DomainError('A manager is required')
    }
    if (typeof bookingId !== 'string' || bookingId.length === 0) {
      throw new DomainError('A booking is required')
    }

    return runInTransaction(this.dataSource, async (manager) => {
      const booking = await this.repository.findForUpdate(manager, bookingId)
      if (booking === null) {
        throw new NotFoundError('The booking was not found')
      }

      if (booking.employeeId === managerId) {
        throw new DomainError('A manager cannot approve or reject their own booking request')
      }

      if (booking.status !== 'PENDING') {
        throw new DomainError(`Cannot approve booking from status: ${booking.status}`)
      }

      const room = await this.repository.findRoom(manager, booking.roomId)
      if (room === null) {
        throw new NotFoundError('The booking room was not found')
      }
      if (!room.isActive) {
        throw new ConflictError('The selected room is inactive')
      }
      if (booking.numberOfAttendees > room.capacity) {
        throw new ConflictError(
          `Room capacity exceeded: ${booking.numberOfAttendees} attendees requested for a room with capacity ${room.capacity}`,
        )
      }
      if (!(await isRoomAvailable(manager, room.id, booking.startTime, booking.endTime, booking.id))) {
        throw new ConflictError('The selected room is not available for the requested time range')
      }

      const equipmentLines = await this.repository.findBookingEquipment(manager, booking.id)
      for (const item of equipmentLines) {
        const freeQuantity = await getEquipmentFreeQuantity(manager, item.equipmentId, booking.startTime, booking.endTime, booking.id)
        if (item.quantity > freeQuantity) {
          throw new ConflictError(`Equipment ${item.equipmentId} is not available: requested ${item.quantity}, ${freeQuantity} free`)
        }
      }

      const approvedBooking = await this.repository.updateStatus(manager, booking, 'APPROVED')
      await this.auditService.record(manager, {
        bookingId: approvedBooking.id,
        action: 'APPROVE' as AuditAction,
        oldStatus: 'PENDING',
        newStatus: 'APPROVED',
        performedById: managerId,
      })
      this.notifyRequesterOfDecision(
        manager,
        booking.employeeId,
        managerId,
        'BOOKING_APPROVED',
        approvedBooking,
      )
      return approvedBooking
    })
  }

  async rejectBooking(managerId: string, bookingId: string, reason: string): Promise<Booking> {
    if (typeof managerId !== 'string' || managerId.length === 0) {
      throw new DomainError('A manager is required')
    }
    if (typeof bookingId !== 'string' || bookingId.length === 0) {
      throw new DomainError('A booking is required')
    }

    const env = loadEnv()
    if (reason.length < env.rejectionReasonMinLength) {
      throw new InputValidationError([{ field: 'reason', message: `Rejection reason must be at least ${env.rejectionReasonMinLength} characters` }])
    }

    return runInTransaction(this.dataSource, async (manager) => {
      const booking = await this.repository.findForUpdate(manager, bookingId)
      if (booking === null) {
        throw new NotFoundError('The booking was not found')
      }

      if (booking.employeeId === managerId) {
        throw new DomainError('A manager cannot approve or reject their own booking request')
      }

      if (booking.status !== 'PENDING') {
        throw new DomainError(`Cannot reject booking from status: ${booking.status}`)
      }

      booking.rejectionReason = reason
      const rejectedBooking = await this.repository.updateStatus(manager, booking, 'REJECTED')
      await this.auditService.record(manager, {
        bookingId: rejectedBooking.id,
        action: 'REJECT' as AuditAction,
        oldStatus: 'PENDING',
        newStatus: 'REJECTED',
        performedById: managerId,
      })
      this.notifyRequesterOfDecision(
        manager,
        booking.employeeId,
        managerId,
        'BOOKING_REJECTED',
        rejectedBooking,
        reason,
      )
      return rejectedBooking
    })
  }
}
