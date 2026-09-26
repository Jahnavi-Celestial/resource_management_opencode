import cron, { type ScheduledTask } from 'node-cron'
import type { OutboundEmailJob } from './dispatch-outbound-emails.job'

export type Scheduler = {
  start(): void
  stop(): Promise<void>
  tasks: ReadonlyArray<{ name: string; schedule: string }>
}

/**
 * node-cron registration. Jobs are described by their own `schedule` so the
 * cadence lives with the job, not here. `noOverlap` is deliberately not set:
 * the dispatcher claims rows with FOR UPDATE SKIP LOCKED plus a lease, so a slow
 * run is safe — a second run simply finds nothing due.
 */
export function createScheduler(jobs: readonly OutboundEmailJob[]): Scheduler {
  const tasks: ScheduledTask[] = []
  const registered = jobs.map((job) => {
    if (!cron.validate(job.schedule)) {
      throw new Error(`Invalid cron expression: ${job.schedule}`)
    }
    const task = cron.schedule(job.schedule, () => {
      void job.run().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[scheduler] job failed: ${message}`)
      })
    })
    tasks.push(task)
    return { name: 'dispatch-outbound-emails', schedule: job.schedule }
  })

  return {
    start() {
      for (const task of tasks) {
        task.start()
      }
    },
    async stop() {
      for (const task of tasks) {
        task.stop()
      }
    },
    tasks: registered,
  }
}
