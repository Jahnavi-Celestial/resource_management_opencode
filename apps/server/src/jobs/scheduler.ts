import cron, { type ScheduledTask } from 'node-cron'

/**
 * What the scheduler needs from a job, and nothing more: a name to log, a cron
 * expression to fire on, and a `run`. Every job in `src/jobs/` is a plain
 * callable first and a scheduled job second, which is what lets the S10
 * acceptance suites invoke them directly with an injected clock instead of
 * waiting on a timer.
 */
export type ScheduledJob = {
  name: string
  schedule: string
  run(): Promise<unknown>
}

export type Scheduler = {
  start(): void
  stop(): Promise<void>
  tasks: ReadonlyArray<{ name: string; schedule: string }>
}

/**
 * node-cron registration. Jobs carry their own `schedule`, so the cadence lives
 * with the job rather than here, and main.ts logs exactly what this registered.
 *
 * Three deliberate properties:
 *
 * - **`noOverlap` is not set**, and that is safe for all three registered jobs
 *   because each is idempotent *and* concurrency-safe, not merely idempotent:
 *   the outbox dispatcher claims rows with `FOR UPDATE SKIP LOCKED` plus a lease;
 *   complete-elapsed-bookings re-checks status and end time under `FOR UPDATE`
 *   before each write; send-reminders re-checks the FR-75 `NOT EXISTS` inside its
 *   write transaction and falls back on the S1 unique index. An overlapping run
 *   finds nothing due — it does not duplicate work.
 * - **No catch-up run on start.** Booting does not immediately fire the jobs, so
 *   a restart never stampedes the database at the moment it is also serving
 *   requests. Whatever elapsed while the process was down is picked up by the
 *   first tick that comes due, which is safe precisely because the jobs are
 *   idempotent.
 * - **One bad run does not kill the schedule.** A rejected `run()` is logged and
 *   the next tick fires as normal; node-cron's own rejection handling would
 *   otherwise leave an unhandled promise rejection behind.
 */
export function createScheduler(jobs: readonly ScheduledJob[]): Scheduler {
  const tasks: ScheduledTask[] = []
  const seen = new Set<string>()

  const registered = jobs.map((job) => {
    if (typeof job.name !== 'string' || job.name.length === 0) {
      throw new Error('A scheduled job must have a name')
    }
    if (seen.has(job.name)) {
      throw new Error(`Duplicate scheduled job name: ${job.name}`)
    }
    seen.add(job.name)
    if (!cron.validate(job.schedule)) {
      throw new Error(`Invalid cron expression for ${job.name}: ${job.schedule}`)
    }
    // `scheduled: false` is load-bearing. node-cron's `schedule()` starts the
    // task immediately unless told otherwise, so without it constructing a
    // scheduler would be a side effect: the job would already be live before
    // `start()` was called, a rejected registration would leave a running timer
    // behind, and a scheduler that was only ever built (as an acceptance test
    // does) would keep the process alive forever.
    const task = cron.schedule(job.schedule, () => {
      void job.run().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[scheduler] ${job.name} failed: ${message}`)
      })
    }, { scheduled: false })
    tasks.push(task)
    return { name: job.name, schedule: job.schedule }
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
