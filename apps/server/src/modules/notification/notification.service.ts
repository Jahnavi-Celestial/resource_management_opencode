import type { EntityManager } from 'typeorm'
import { ConflictError } from '../../common/errors/conflict-error'
import { NotFoundError } from '../../common/errors/not-found-error'
import type { PaginationArgs } from '../../common/pagination/apply-pagination'
import type { Paginated } from '../../common/pagination/paginated'
import type { SortInput } from '../../common/pagination/sort-input'
import { emitRealtimeEvent } from '../../realtime/gateway'
import type { RealtimeEmitter } from '../../realtime/events'
import { NotificationRepository, type NotificationFilters } from './notification.repository'
import { toNotificationRecordType, type NotificationRecordType } from './notification.types'
import { Notification } from './notification.entity'
import type { NotificationType } from '@resource-booking/shared'

export type NotificationCreateInput = {
  recipientId: string
  bookingId: string
  type: NotificationType
  title: string
  message: string
}

export type BookingNotificationDetails = {
  bookingId: string
  purpose: string
  startTime: Date
  endTime: Date
  reason?: string
}

export type BookingDecisionType = Extract<
  NotificationType,
  'BOOKING_APPROVED' | 'BOOKING_REJECTED' | 'BOOKING_CANCELLED'
>

const DECISION_TITLES: Record<BookingDecisionType, string> = {
  BOOKING_APPROVED: 'Booking approved',
  BOOKING_REJECTED: 'Booking rejected',
  BOOKING_CANCELLED: 'Booking cancelled',
}

function window(startTime: Date, endTime: Date): string {
  return `${startTime.toISOString()} to ${endTime.toISOString()}`
}

function decisionContent(
  type: BookingDecisionType,
  details: BookingNotificationDetails,
): { title: string; message: string } {
  const subject = `your booking "${details.purpose}" (${window(details.startTime, details.endTime)})`
  const reason = type === 'BOOKING_REJECTED' && details.reason !== undefined && details.reason !== ''
    ? ` Reason: ${details.reason}`
    : ''
  return {
    title: DECISION_TITLES[type],
    message: `Another party ${type === 'BOOKING_APPROVED' ? 'approved' : type === 'BOOKING_REJECTED' ? 'rejected' : 'cancelled'} ${subject}.${reason}`,
  }
}

const UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } }
  return candidate.code === UNIQUE_VIOLATION || candidate.driverError?.code === UNIQUE_VIOLATION
}

export class NotificationService {
  private readonly repository: NotificationRepository
  private readonly emit: RealtimeEmitter

  constructor(repository = new NotificationRepository(), emit: RealtimeEmitter = emitRealtimeEvent) {
    this.repository = repository
    this.emit = emit
  }

  async create(manager: EntityManager, input: NotificationCreateInput): Promise<NotificationRecordType> {
    const repository = manager.getRepository(Notification)
    try {
      const saved = await repository.save(
        repository.create({
          recipientId: input.recipientId,
          bookingId: input.bookingId,
          type: input.type,
          title: input.title,
          message: input.message,
        }),
      )
      return toNotificationRecordType(saved)
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          `A ${input.type} notification already exists for this booking and recipient`,
        )
      }
      throw error
    }
  }

  async list(
    manager: EntityManager,
    recipientId: string,
    args: PaginationArgs,
    sort: SortInput | null | undefined,
    filters: NotificationFilters = {},
  ): Promise<Paginated<NotificationRecordType>> {
    const result = await this.repository.list(manager, recipientId, args, sort, filters)
    return {
      items: result.items.map(toNotificationRecordType),
      totalCount: result.totalCount,
    }
  }

  unreadCount(manager: EntityManager, recipientId: string): Promise<number> {
    return this.repository.countUnread(manager, recipientId)
  }

  async markRead(
    manager: EntityManager,
    recipientId: string,
    id: string,
  ): Promise<NotificationRecordType> {
    const notification = await this.repository.markRead(manager, recipientId, id)
    if (notification === null) {
      throw new NotFoundError('Notification not found')
    }
    return toNotificationRecordType(notification)
  }

  markAllRead(manager: EntityManager, recipientId: string): Promise<number> {
    return this.repository.markAllRead(manager, recipientId)
  }

  async notifyApprovers(
    manager: EntityManager,
    details: BookingNotificationDetails & { requesterId: string },
  ): Promise<NotificationRecordType[]> {
    const approverIds = await this.repository.findApproverEmployeeIds(manager, details.requesterId)
    const created: NotificationRecordType[] = []
    for (const approverId of approverIds) {
      created.push(
        await this.create(manager, {
          recipientId: approverId,
          bookingId: details.bookingId,
          type: 'BOOKING_PENDING',
          title: 'New booking awaiting approval',
          message: `A new booking request "${details.purpose}" (${window(details.startTime, details.endTime)}) is awaiting your approval.`,
        }),
      )
    }
    return created
  }

  notifyRequesterOfDecision(
    manager: EntityManager,
    recipientId: string,
    type: BookingDecisionType,
    details: BookingNotificationDetails,
  ): Promise<NotificationRecordType> {
    const content = decisionContent(type, details)
    return this.create(manager, {
      recipientId,
      bookingId: details.bookingId,
      type,
      title: content.title,
      message: content.message,
    })
  }

  /**
   * Pushes already-persisted notifications to the recipient's live sockets,
   * each with that recipient's unread count as of now (the new row is included
   * because it is unread). Call this only once the write transaction has
   * committed, otherwise a rollback would still have pushed the event.
   *
   * Purely a best-effort side channel: it returns the number of sockets
   * reached, 0 when the recipient is offline, and never throws for want of a
   * listener — the database row is the source of truth either way.
   */
  async emitCreated(
    manager: EntityManager,
    created: readonly NotificationRecordType[],
  ): Promise<number> {
    let delivered = 0
    for (const notification of created) {
      const unreadCount = await this.unreadCount(manager, notification.recipientId)
      delivered += this.emit(notification.recipientId, {
        type: 'notification.created',
        notification,
        unreadCount,
      })
    }
    return delivered
  }
}
