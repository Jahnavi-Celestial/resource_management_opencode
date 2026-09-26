import type { EntityManager } from 'typeorm'
import { Employee } from '../modules/employee/employee.entity'
import { EmailOutbox } from './email-outbox.entity'
import type {
  BookingEmailData,
  BookingEmailDataInput,
  EmailEnqueueInput,
  EmailTemplate,
  OutboxRecord,
} from './email.types'
import { toOutboxRecord } from './email.types'

const TEMPLATE_SUBJECTS: Record<EmailTemplate, (data: BookingEmailData) => string> = {
  BOOKING_APPROVED: (data) => `Your booking "${headerSafe(data.purpose)}" was approved`,
  BOOKING_REJECTED: (data) => `Your booking "${headerSafe(data.purpose)}" was rejected`,
  BOOKING_REMINDER: (data) => `Reminder: your booking "${headerSafe(data.purpose)}" is coming up`,
}

const TEMPLATE_INTROS: Record<EmailTemplate, string> = {
  BOOKING_APPROVED: 'A manager approved your booking request.',
  BOOKING_REJECTED: 'A manager rejected your booking request.',
  BOOKING_REMINDER: 'This is a reminder about your upcoming booking.',
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The subject is a plain-text mail header, so escaping HTML does not protect it:
 * a purpose containing CR/LF would let a user append arbitrary headers (Bcc: …)
 * to the message. Collapse whitespace, drop the rest of the control range and
 * cap the length.
 */
function headerSafe(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function window_(data: BookingEmailData): string {
  return `${data.startTime} to ${data.endTime}`
}

/**
 * Renders at enqueue time, not at send time: the stored row is then a faithful
 * record of exactly what the user was promised, and the dispatcher stays a dumb
 * pipe. Every interpolated value is escaped — `purpose` and `reason` are
 * user-supplied free text.
 */
function render(template: EmailTemplate, data: BookingEmailData & { reason?: string }): { subject: string; html: string } {
  const subject = TEMPLATE_SUBJECTS[template](data)
  const reason =
    template === 'BOOKING_REJECTED' && data.reason !== undefined && data.reason !== ''
      ? `<p><strong>Reason:</strong> ${escapeHtml(data.reason)}</p>`
      : ''
  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif">
    <p>Hello ${escapeHtml(data.employeeName)},</p>
    <p>${escapeHtml(TEMPLATE_INTROS[template])}</p>
    <ul>
      <li><strong>Purpose:</strong> ${escapeHtml(data.purpose)}</li>
      <li><strong>Room:</strong> ${escapeHtml(data.roomName)}</li>
      <li><strong>When:</strong> ${escapeHtml(window_(data))}</li>
    </ul>
    ${reason}
  </body>
</html>`
  return { subject, html }
}

/**
 * FR-61 outbox. `enqueue` takes the caller's EntityManager and opens no
 * transaction of its own, so it can be called from inside the post-commit
 * write transaction that the booking lifecycle already runs. It never
 * dispatches: a row is durable evidence that an email is owed, and the
 * dispatcher is the only thing that talks to a provider.
 */
export class EmailService {
  /**
   * Writes one outbox row. The recipient address is taken from the employee
   * record rather than from the caller, so a stale or spoofed address can never
   * reach a provider. Resolves to null when the employee no longer exists
   * (FR-7 hard delete) — there is nobody left to email.
   */
  async enqueueForEmployee(
    manager: EntityManager,
    employeeId: string,
    template: EmailTemplate,
    data: BookingEmailDataInput,
  ): Promise<OutboxRecord | null> {
    const employee = await manager.getRepository(Employee).findOneBy({ id: employeeId })
    if (employee === null) {
      return null
    }
    return this.enqueue(manager, {
      to: employee.email,
      template,
      data: { ...data, employeeName: `${employee.firstName} ${employee.lastName}` },
    } as EmailEnqueueInput)
  }

  async enqueue(manager: EntityManager, input: EmailEnqueueInput): Promise<OutboxRecord> {
    const rendered = render(input.template, input.data)
    const saved = await manager.getRepository(EmailOutbox).save(
      manager.getRepository(EmailOutbox).create({
        toEmail: input.to,
        subject: rendered.subject,
        html: rendered.html,
        eventType: input.template,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        sentAt: null,
      }),
    )
    return toOutboxRecord(saved)
  }
}
