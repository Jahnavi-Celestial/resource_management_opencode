export const NOTIFICATION_TYPES = [
  'BOOKING_PENDING',
  'BOOKING_APPROVED',
  'BOOKING_REJECTED',
  'BOOKING_CANCELLED',
  'REMINDER',
] as const

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]
