import type { NotificationRecordType } from '../modules/notification/notification.types'
import type { NotificationType } from '@resource-booking/shared'

/**
 * Outbound realtime event shapes. Every event carries a discriminant in `type`
 * so the client can switch on it without guessing from the payload keys.
 */
export type NotificationCreatedEvent = {
  type: 'notification.created'
  notification: NotificationRecordType
  unreadCount: number
}

export type RealtimeEvent = NotificationCreatedEvent

/**
 * Delivers one event to every live connection owned by `employeeId`.
 * Returns the number of sockets the event was actually written to, which is 0
 * when the user has no active connection — a missing socket is never an error.
 */
export type RealtimeEmitter = (employeeId: string, event: RealtimeEvent) => number
