import type { DataSource } from 'typeorm'
import { dispatchPendingEmails, type DispatchSummary } from '../email/dispatcher'
import type { EmailProvider } from '../email/email.types'

export type OutboundEmailJob = {
  /** Cron expression, from `EMAIL_DISPATCH_CRON`. */
  schedule: string
  maxAttempts: number
  run(): Promise<DispatchSummary>
}

/**
 * FR-61/FR-90. Runs on a schedule, outside any booking transaction — by the time
 * this runs the booking is long committed, so a send failure can only ever cost
 * a retry. Logs a one-line summary per run; a provider failure is already
 * recorded on the row by the dispatcher.
 */
export function createDispatchOutboundEmailsJob(
  dataSource: DataSource,
  provider: EmailProvider,
  options: { schedule: string; maxAttempts: number; now?: () => Date },
): OutboundEmailJob {
  const run = async (): Promise<DispatchSummary> => {
    const summary = await dispatchPendingEmails(dataSource, provider, {
      maxAttempts: options.maxAttempts,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    if (summary.claimed > 0) {
      console.log(
        `[email] dispatch run: claimed=${String(summary.claimed)} sent=${String(summary.sent)} failed=${String(summary.failed)} deadLettered=${String(summary.deadLettered)}`,
      )
    }
    return summary
  }
  return { schedule: options.schedule, maxAttempts: options.maxAttempts, run }
}
