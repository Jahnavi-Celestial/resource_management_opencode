import type { DataSource } from 'typeorm'
import { runInTransaction } from '../common/db/transaction'
import { loadEnv } from '../config/env'
import { AuditService } from '../modules/audit/audit.service'
import type { AuditAction } from '../modules/audit/audit-log.entity'
import { BookingRepository } from '../modules/booking/booking.repository'
import { EmployeeRepository } from '../modules/employee/employee.repository'
import { SYSTEM_EMPLOYEE_EMAIL } from '../modules/employee/system-account'

export type CompleteElapsedBookingsSummary = {
  /** Candidates the scan found (APPROVED, elapsed) before any transition. */
  scanned: number
  /** Bookings actually transitioned to COMPLETED by this run. */
  completed: number
  /** One entry per candidate whose transaction rolled back; the rest still ran. */
  failed: Array<{ bookingId: string; error: string }>
}

export type CompleteElapsedBookingsJob = {
  name: string
  schedule: string
  run(): Promise<CompleteElapsedBookingsSummary>
}

export type CompleteElapsedBookingsOptions = {
  /** Cron expression. Defaults to `BOOKING_JOBS_CRON` (PLAN.md assumption #10). */
  schedule?: string
  /** Injected clock, so tests drive "elapsed" without sleeping. */
  now?: () => Date
  /** Max candidates per run. Older `end_time`s are drained first. */
  batchSize?: number
}

const JOB_NAME = 'complete-elapsed-bookings'
const DEFAULT_BATCH_SIZE = 500

/**
 * FR-72: APPROVED bookings whose end time has elapsed become COMPLETED, with a
 * COMPLETE audit row attributed to the reserved system employee.
 *
 * Two properties the requirements care about, and how they are got:
 *
 * - **Atomicity (FR-63/NFR-3).** One transaction *per booking*: the status
 *   change and its audit row commit or roll back together. A batch transaction
 *   would be simpler but would let one bad row cost every good row in the batch.
 * - **Idempotency (FR-75).** The candidate query filters on `status = 'APPROVED'
 *   AND end_time < now`, and each booking is then re-checked *inside* its own
 *   transaction while holding `FOR UPDATE`. A second run over the same window
 *   therefore finds no candidates and, even if two runs overlap, the loser sees
 *   `COMPLETED` (or a non-elapsed window) and skips. No duplicate audit row is
 *   reachable — the audit write and the status change are one indivisible unit.
 *
 * Deliberately does **not** re-validate room/equipment availability and does not
 * touch `availability.ts`: completion is a pure time-based transition, and a
 * COMPLETED booking already falls outside availability's `PENDING/APPROVED`
 * filter, so it stops occupying its slot with no release step (FR-73).
 *
 * A per-booking failure is collected and the run continues — one poisoned row
 * must not strand every other elapsed booking forever.
 */
export function createCompleteElapsedBookingsJob(
  dataSource: DataSource,
  options: CompleteElapsedBookingsOptions = {},
): CompleteElapsedBookingsJob {
  const now = options.now ?? ((): Date => new Date())
  const schedule = options.schedule ?? loadEnv().bookingJobsCron
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const auditService = new AuditService()

  const run = async (): Promise<CompleteElapsedBookingsSummary> => {
    const runStartedAt = now()

    // The system employee is the actor on every COMPLETE row. Resolved once per
    // run, and resolved *before* any transition: without it there is no actor to
    // attribute (FR-72/§6), so failing loudly is better than writing rows that
    // cannot be attributed.
    const systemEmployee = await new EmployeeRepository(dataSource.manager).findByEmail(
      SYSTEM_EMPLOYEE_EMAIL,
    )
    if (systemEmployee === null) {
      throw new Error(
        `System employee "${SYSTEM_EMPLOYEE_EMAIL}" is missing — run the seeds before the completion job`,
      )
    }
    const systemEmployeeId = systemEmployee.id

    const repository = new BookingRepository()
    const candidates = await repository.findElapsedApproved(
      dataSource.manager,
      runStartedAt,
      batchSize,
    )

    const failed: Array<{ bookingId: string; error: string }> = []
    let completed = 0

    for (const candidate of candidates) {
      try {
        const transitioned = await runInTransaction(dataSource, async (manager) => {
          const booking = await repository.findForUpdate(manager, candidate.id)

          // Re-check under the row lock: the scan ran on `dataSource.manager`
          // outside this transaction, so the booking may have been cancelled,
          // rejected or already completed since. Skipping here is what makes an
          // overlapping re-run a no-op rather than a double COMPLETE audit row.
          if (booking === null || booking.status !== 'APPROVED' || booking.endTime >= runStartedAt) {
            return false
          }

          const completedBooking = await repository.updateStatus(manager, booking, 'COMPLETED')
          await auditService.record(manager, {
            bookingId: completedBooking.id,
            action: 'COMPLETE' as AuditAction,
            oldStatus: 'APPROVED',
            newStatus: 'COMPLETED',
            performedById: systemEmployeeId,
          })
          return true
        })

        if (transitioned) {
          completed += 1
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[jobs] complete-elapsed-bookings: ${candidate.id} failed: ${message}`)
        failed.push({ bookingId: candidate.id, error: message })
      }
    }

    if (completed > 0 || failed.length > 0) {
      console.log(
        `[jobs] complete-elapsed-bookings: scanned=${String(candidates.length)} completed=${String(completed)} failed=${String(failed.length)}`,
      )
    }

    return { scanned: candidates.length, completed, failed }
  }

  return { name: JOB_NAME, schedule, run }
}
