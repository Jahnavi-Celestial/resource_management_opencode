import type { DataSource } from 'typeorm'
import { AuditService } from '../audit/audit.service'
import type { AuditAction } from '../audit/audit-log.entity'
import { DomainError } from '../../common/errors/domain-error'
import { ConflictError } from '../../common/errors/conflict-error'
import { NotFoundError } from '../../common/errors/not-found-error'
import { InputValidationError } from '../../common/errors/field-errors'
import { runInTransaction } from '../../common/db/transaction'
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
import type { PaginationArgs } from '../../common/pagination/apply-pagination'
import type { SortInput } from '../../common/pagination/sort-input'
import { loadEnv } from '../../config/env'

export class BookingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly repository: BookingRepository = new BookingRepository(),
    private readonly auditService: AuditService = new AuditService(),
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

      return booking
    })
  }

  async cancelOwnBooking(employeeId: string, bookingId: string): Promise<Booking> {
    return this.cancelBooking(employeeId, bookingId, true)
  }

  async cancelAnyBooking(employeeId: string, bookingId: string): Promise<Booking> {
    return this.cancelBooking(employeeId, bookingId, false)
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
      return rejectedBooking
    })
  }
}
