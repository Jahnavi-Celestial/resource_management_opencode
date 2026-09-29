import type { EmailOutboxStatus } from './email-outbox.entity'

/**
 * The transactional emails the system sends. The name is stored verbatim in
 * `email_outbox.event_type`, so it doubles as the audit trail of why a given
 * email was sent.
 */
export const EMAIL_TEMPLATES = [
  'BOOKING_APPROVED',
  'BOOKING_REJECTED',
  'BOOKING_REMINDER',
  'EMPLOYEE_WELCOME',
] as const
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number]

/** Everything a rendered booking email needs. All values are user-influenced. */
export type BookingEmailData = {
  employeeName: string
  purpose: string
  roomName: string
  startTime: string
  endTime: string
}

/**
 * What a caller supplies to `enqueueForEmployee`: everything except the
 * recipient's name, which the service reads from the employee record so it
 * cannot be spoofed.
 */
export type BookingEmailDataInput = Omit<BookingEmailData, 'employeeName'> & { reason?: string }

/**
 * The welcome email's caller-supplied fields. The plaintext password exists
 * only in the create input — the store keeps a hash — so this is the one
 * moment it can be emailed. It is escaped at render time like every other
 * interpolated value.
 */
export type EmployeeWelcomeEmailDataInput = {
  email: string
  password: string
}

/**
 * Template and data are one discriminated union, so a caller cannot send a
 * rejection email without a reason or pair a subject with the wrong template.
 */
export type EmailTemplateData =
  | { template: 'BOOKING_APPROVED'; data: BookingEmailData }
  | { template: 'BOOKING_REJECTED'; data: BookingEmailData & { reason: string } }
  | { template: 'BOOKING_REMINDER'; data: BookingEmailData }
  | { template: 'EMPLOYEE_WELCOME'; data: BookingEmailData & EmployeeWelcomeEmailDataInput }

/** The full data a template renders with, keyed by template. */
export type EmailDataFor<T extends EmailTemplate> = Extract<EmailTemplateData, { template: T }>['data']

/** What a caller passes for a template: the data minus the service-filled name. */
export type EmailDataInputFor<T extends EmailTemplate> = Omit<EmailDataFor<T>, 'employeeName'>

export type EmailEnqueueInput = { to: string } & EmailTemplateData

/** A provider-agnostic message. Rendered at enqueue time, sent much later. */
export type OutboundEmail = {
  to: string
  from: string
  subject: string
  html: string
  eventType: EmailTemplate
  outboxId: string
}

export type OutboxRecord = {
  id: string
  toEmail: string
  subject: string
  html: string
  eventType: string
  status: EmailOutboxStatus
  attempts: number
  nextAttemptAt: Date | null
  lastError: string | null
  createdAt: Date
  sentAt: Date | null
}

export function toOutboxRecord(row: {
  id: string
  toEmail: string
  subject: string
  html: string
  eventType: string
  status: EmailOutboxStatus
  attempts: number
  nextAttemptAt: Date | null
  lastError: string | null
  createdAt: Date
  sentAt: Date | null
}): OutboxRecord {
  return { ...row }
}

/**
 * A transport. `send` must reject on any delivery failure — the dispatcher owns
 * retries, so a provider that swallows errors is a bug.
 */
export interface EmailProvider {
  readonly name: string
  readonly from: string
  send(message: OutboundEmail): Promise<void>
}
