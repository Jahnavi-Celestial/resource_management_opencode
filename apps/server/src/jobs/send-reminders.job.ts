import type { DataSource } from 'typeorm'
import { runInTransaction } from '../common/db/transaction'
import { loadEnv } from '../config/env'
import { EmailService } from '../email/email.service'
import { BookingRepository } from '../modules/booking/booking.repository'
import { NotificationRepository } from '../modules/notification/notification.repository'
import { NotificationService } from '../modules/notification/notification.service'
import type { NotificationRecordType } from '../modules/notification/notification.types'
import { ConflictError } from '../common/errors/conflict-error'

export type SendRemindersSummary = {
  /** Candidates the scan returned — already excludes anything already reminded. */
  scanned: number
  /** REMINDER notifications created by this run. */
  created: number
  /** Bookings whose requester no longer exists (FR-7 hard delete). */
  skippedNoRecipient: number
  /** Bookings that gained a reminder between the scan and the write. */
  skippedAlreadyReminded: number
  /** One entry per candidate whose transaction rolled back; the rest still ran. */
  failed: Array<{ bookingId: string; error: string }>
  /** Live sockets reached by the post-commit push (0 when everyone is offline). */
  delivered: number
}

export type SendRemindersJob = {
  name: string
  schedule: string
  run(): Promise<SendRemindersSummary>
}

export type SendRemindersOptions = {
  /** Cron expression. Defaults to `BOOKING_JOBS_CRON` (PLAN.md assumption #10). */
  schedule?: string
  /** Injected clock, so tests drive the window without sleeping. */
  now?: () => Date
  /** Defaults to `REMINDER_LEAD_TIME_MINUTES` from the env config. */
  leadTimeMinutes?: number
  /** Max candidates per run. Soonest start times are handled first. */
  batchSize?: number
}

const JOB_NAME = 'send-reminders'
const DEFAULT_BATCH_SIZE = 500
const REMINDER_TITLE = 'Upcoming booking reminder'

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000))
}

function reminderMessage(
  purpose: string,
  startTime: Date,
  endTime: Date,
  leadTimeMinutes: number,
  now: Date,
): string {
  const minutes = minutesBetween(now, startTime)
  const when = minutes < 60 ? `${String(minutes)} minute(s)` : `${String(Math.round(minutes / 60))} hour(s)`
  return (
    `Reminder: your booking "${purpose}" ` +
    `(${startTime.toISOString()} to ${endTime.toISOString()}) starts in ${when}. ` +
    `It was due to start within ${String(leadTimeMinutes)} minutes of this reminder.`
  )
}

/**
 * FR-74/75. Reminds the requester of every booking that is about to start.
 *
 * - **Window.** `start_time > now AND start_time <= now + REMINDER_LEAD_TIME_MINUTES`,
 *   so a booking that has already begun is never reminded after the fact.
 * - **Statuses.** PENDING and APPROVED only. A CANCELLED/REJECTED/COMPLETED
 *   booking will not happen, and telling the requester it is "coming up" is a lie.
 * - **Recipient.** The booking's requester, resolved from the booking row.
 * - **Idempotency (FR-75).** A `NOT EXISTS` against `notification` for a
 *   REMINDER — no timestamp column, per the requirement's explicit instruction.
 *   It runs twice: once as a SQL pre-filter in the scan, and once again inside
 *   the write transaction via `NotificationRepository.hasReminder`, which is the
 *   one that decides. A re-run over the same window therefore scans nothing and
 *   writes nothing. If two runs still race past both checks, the S1 unique index
 *   on `(booking_id, recipient_id, type)` rejects the loser, and its
 *   `ConflictError` is counted as `skippedAlreadyReminded` rather than a failure.
 * - **Post-commit side effects (FR-90).** The websocket push runs only after the
 *   transaction has committed, via the same `NotificationService.emitCreated`
 *   path the booking lifecycle uses; a rollback is never pushed. The database row
 *   is written regardless of who is connected.
 *
 * FR-61 also requires a transactional email for "upcoming-booking reminder
 * events", and `BOOKING_REMINDER` is already a rendered outbox template from S9
 * with no producer — this job is that producer. The outbox row is written in the
 * same transaction as the notification: for a job that re-runs on a schedule,
 * one transaction is the right retry unit (a failure rolls the whole reminder
 * back and the next run attempts it again, and the NOT EXISTS check keeps that
 * retry idempotent), and the dispatcher still owns the actual send.
 */
export function createSendRemindersJob(
  dataSource: DataSource,
  options: SendRemindersOptions = {},
): SendRemindersJob {
  const now = options.now ?? ((): Date => new Date())
  const schedule = options.schedule ?? loadEnv().bookingJobsCron
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const leadTimeMinutes = options.leadTimeMinutes ?? loadEnv().reminderLeadTimeMinutes
  if (!Number.isFinite(leadTimeMinutes) || leadTimeMinutes <= 0) {
    throw new Error(`REMINDER_LEAD_TIME_MINUTES must be a positive number, got ${String(leadTimeMinutes)}`)
  }

  const bookingRepository = new BookingRepository()
  const notificationRepository = new NotificationRepository()
  const notificationService = new NotificationService(notificationRepository)
  const emailService = new EmailService()

  const run = async (): Promise<SendRemindersSummary> => {
    const runStartedAt = now()
    const horizon = new Date(runStartedAt.getTime() + leadTimeMinutes * 60_000)

    const candidates = await bookingRepository.findStartingWithinLeadTime(
      dataSource.manager,
      runStartedAt,
      horizon,
      batchSize,
    )

    const failed: Array<{ bookingId: string; error: string }> = []
    let created = 0
    let skippedNoRecipient = 0
    let skippedAlreadyReminded = 0
    let delivered = 0

    for (const candidate of candidates) {
      // FR-7: the requester record was hard-deleted, so there is nobody to notify
      // and no address to send the outbox row to. Counted, not crashed on.
      if (candidate.employeeId === null) {
        skippedNoRecipient += 1
        continue
      }
      const requesterId = candidate.employeeId

      try {
        const notification = await runInTransaction(dataSource, async (manager) => {
          // The authoritative FR-75 check, under the same transaction as the
          // insert. The scan's NOT EXISTS ran outside one, so on its own it would
          // let two overlapping runs both create a reminder.
          if (await notificationRepository.hasReminder(manager, candidate.id)) {
            return null
          }

          const room = await bookingRepository.findRoom(manager, candidate.roomId)
          const createdNotification = await notificationService.create(manager, {
            recipientId: requesterId,
            bookingId: candidate.id,
            type: 'REMINDER',
            title: REMINDER_TITLE,
            message: reminderMessage(
              candidate.purpose,
              candidate.startTime,
              candidate.endTime,
              leadTimeMinutes,
              runStartedAt,
            ),
          })

          await emailService.enqueueForEmployee(manager, requesterId, 'BOOKING_REMINDER', {
            purpose: candidate.purpose,
            roomName: room?.name ?? 'a room',
            startTime: candidate.startTime.toISOString(),
            endTime: candidate.endTime.toISOString(),
          })

          return createdNotification
        })

        if (notification === null) {
          skippedAlreadyReminded += 1
          continue
        }

        created += 1
        delivered += await pushAfterCommit(dataSource, notificationService, notification)
      } catch (error: unknown) {
        if (error instanceof ConflictError) {
          // Lost the race against a concurrent run; the unique index did its job.
          skippedAlreadyReminded += 1
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[jobs] send-reminders: ${candidate.id} failed: ${message}`)
        failed.push({ bookingId: candidate.id, error: message })
      }
    }

    if (created > 0 || failed.length > 0) {
      console.log(
        `[jobs] send-reminders: scanned=${String(candidates.length)} created=${String(created)} ` +
          `delivered=${String(delivered)} skippedNoRecipient=${String(skippedNoRecipient)} ` +
          `skippedAlreadyReminded=${String(skippedAlreadyReminded)} failed=${String(failed.length)}`,
      )
    }

    return { scanned: candidates.length, created, skippedNoRecipient, skippedAlreadyReminded, failed, delivered }
  }

  return { name: JOB_NAME, schedule, run }
}

/**
 * FR-90: the push happens only after the write transaction has committed, through
 * the same `emitCreated` path the booking lifecycle uses, and a push failure can
 * never undo a committed row.
 */
async function pushAfterCommit(
  dataSource: DataSource,
  notificationService: NotificationService,
  notification: NotificationRecordType,
): Promise<number> {
  try {
    return await notificationService.emitCreated(dataSource.manager, [notification])
  } catch (error: unknown) {
    console.error('[jobs] send-reminders: post-commit push failed', error)
    return 0
  }
}
