export const BOOKING_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED'] as const

export type BookingStatus = (typeof BOOKING_STATUSES)[number]
