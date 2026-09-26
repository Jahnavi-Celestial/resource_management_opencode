import type { DataSource } from 'typeorm'
import { EmailOutbox, type EmailOutboxStatus } from './email-outbox.entity'
import { EMAIL_TEMPLATES, type EmailProvider, type EmailTemplate, type OutboxRecord } from './email.types'
import { toOutboxRecord } from './email.types'

export const DEFAULT_BATCH_SIZE = 20
export const DEFAULT_MAX_ATTEMPTS = 5
export const DEFAULT_RETRY_BASE_MS = 30_000
export const DEFAULT_RETRY_CAP_MS = 60 * 60_000
export const DEFAULT_LEASE_MS = 60_000

export type DispatchOptions = {
  batchSize?: number
  maxAttempts?: number
  retryBaseMs?: number
  retryCapMs?: number
  leaseMs?: number
  now?: () => Date
}

export type DispatchSummary = {
  claimed: number
  sent: number
  failed: number
  deadLettered: number
  rows: OutboxRecord[]
}

export type EmailOutboxRepository = {
  claimDue(limit: number, now: Date, leaseUntil: Date): Promise<OutboxRecord[]>
  markSent(id: string, attempts: number, sentAt: Date): Promise<void>
  markFailed(id: string, status: EmailOutboxStatus, attempts: number, lastError: string, nextAttemptAt: Date | null): Promise<void>
}

/**
 * Exponential backoff, capped. The first retry waits one base interval, the
 * n-th waits base * 2^(n-1) clamped to `retryCapMs`.
 */
export function backoffMs(attempts: number, baseMs: number, capMs: number): number {
  const exponent = Math.max(0, attempts - 1)
  return Math.min(capMs, baseMs * 2 ** exponent)
}

function asEmailTemplate(value: string): EmailTemplate {
  if ((EMAIL_TEMPLATES as readonly string[]).includes(value)) {
    return value as EmailTemplate
  }
  throw new Error(`Unrecognised email_outbox.event_type "${value}"`)
}

/**
 * Durable, at-least-once send queue for FR-61.
 *
 * Design rules that matter:
 * 1. The booking is already committed long before this runs, so nothing here can
 *    roll anything back. The worst case of a failed send is a retry.
 * 2. No database lock is ever held across a provider call. Rows are claimed in
 *    one short transaction (SKIP LOCKED plus a lease written into
 *    `next_attempt_at`), then sent outside it, so a slow provider cannot block
 *    anything else and two dispatcher instances cannot double-send.
 * 3. A send failure is recorded, logged and rescheduled — never rethrown. The
 *    dispatcher is cron-invoked, so a throw would be an unhandled rejection.
 * 4. Only PENDING rows due now are claimable, so a SENT row is never resent
 *    and a row still inside its backoff window is left alone.
 */
export async function dispatchPendingEmails(
  dataSource: DataSource,
  provider: EmailProvider,
  options: DispatchOptions = {},
): Promise<DispatchSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
  const retryCapMs = options.retryCapMs ?? DEFAULT_RETRY_CAP_MS
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const now = options.now ?? ((): Date => new Date())

  const repository: EmailOutboxRepository = {
    async claimDue(limit, at, leaseUntil) {
      // The UPDATE both claims the rows and stamps the lease, so a concurrent
      // dispatcher's SELECT ... FOR UPDATE SKIP LOCKED skips them.
      return dataSource.transaction(async (manager) => {
        const due = await manager
          .getRepository(EmailOutbox)
          .createQueryBuilder('outbox')
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked') // FOR UPDATE SKIP LOCKED
          .where('outbox.status = :status', { status: 'PENDING' })
          .andWhere('(outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= :now)', { now: at })
          .orderBy('outbox.created_at', 'ASC')
          .limit(limit)
          .getMany()
        if (due.length === 0) {
          return []
        }
        await manager
          .getRepository(EmailOutbox)
          .createQueryBuilder()
          .update(EmailOutbox)
          .set({ nextAttemptAt: leaseUntil })
          .whereInIds(due.map((row) => row.id))
          .execute()
        return due.map((row) => toOutboxRecord({ ...row, nextAttemptAt: leaseUntil }))
      })
    },
    async markSent(id, attempts, sentAt) {
      // `attempts` counts provider invocations, successful or not, so it is
      // bumped on both paths — a row that was sent twice must show 2.
      await dataSource.getRepository(EmailOutbox).update(
        { id },
        { status: 'SENT', attempts, sentAt, lastError: null, nextAttemptAt: null },
      )
    },
    async markFailed(id, status, attempts, lastError, nextAttemptAt) {
      await dataSource
        .getRepository(EmailOutbox)
        .update({ id }, { status, attempts, lastError, nextAttemptAt })
    },
  }

  const claimedAt = now()
  const claimed = await repository.claimDue(batchSize, claimedAt, new Date(claimedAt.getTime() + leaseMs))
  const summary: DispatchSummary = { claimed: claimed.length, sent: 0, failed: 0, deadLettered: 0, rows: [] }

  for (const row of claimed) {
    const attempts = row.attempts + 1
    try {
      await provider.send({
        to: row.toEmail,
        from: provider.from,
        subject: row.subject,
        html: row.html,
        // Narrowed inside the try on purpose: a row whose event_type this build
        // does not recognise must fail loudly and be retried/dead-lettered,
        // never be sent with a guessed template.
        eventType: asEmailTemplate(row.eventType),
        outboxId: row.id,
      })
      await repository.markSent(row.id, attempts, now())
      summary.sent += 1
      summary.rows.push({ ...row, status: 'SENT', attempts, sentAt: now() })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const exhausted = attempts >= maxAttempts
      const status: EmailOutboxStatus = exhausted ? 'FAILED' : 'PENDING'
      const nextAttemptAt = exhausted ? null : new Date(now().getTime() + backoffMs(attempts, retryBaseMs, retryCapMs))
      await repository.markFailed(row.id, status, attempts, message, nextAttemptAt)
      console.error(
        `[email] dispatch of outbox ${row.id} to ${row.toEmail} failed (attempt ${String(attempts)}/${String(maxAttempts)}): ${message}`,
      )
      summary.failed += 1
      if (exhausted) {
        summary.deadLettered += 1
      }
      summary.rows.push({ ...row, status, attempts, lastError: message, nextAttemptAt })
    }
  }

  return summary
}
