import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import type { DataSource } from 'typeorm'
import { createDataSource } from '../../config/data-source'
import { loadEnv } from '../../config/env'
import { createCompleteElapsedBookingsJob } from '../complete-elapsed-bookings.job'
import { createDispatchOutboundEmailsJob } from '../dispatch-outbound-emails.job'
import { createSendRemindersJob } from '../send-reminders.job'
import { createScheduler, type ScheduledJob } from '../scheduler'
import { createEmailProvider } from '../../email/providers'

function noopJob(name: string, schedule: string, onRun: () => void): ScheduledJob {
  return {
    name,
    schedule,
    async run() {
      onRun()
      return 0
    },
  }
}

async function main(): Promise<void> {
  process.env.NODE_ENV = 'test'
  const env = loadEnv()
  // No DB connection: this suite never calls `run()` on a real job, it only
  // registers them, and the factories merely capture the DataSource.
  const dataSource: DataSource = createDataSource()
  const dispatcher = createDispatchOutboundEmailsJob(dataSource, createEmailProvider(env), {
    schedule: env.email.dispatchCron,
    maxAttempts: env.email.maxAttempts,
  })
  const completeElapsed = createCompleteElapsedBookingsJob(dataSource, {
    schedule: env.bookingJobsCron,
  })
  const sendReminders = createSendRemindersJob(dataSource, { schedule: env.bookingJobsCron })

  // --- 1. the three jobs main.ts registers carry a name and a valid cron -----
  const scheduler = createScheduler([dispatcher, completeElapsed, sendReminders])
  const registered = scheduler.tasks.map((task) => `${task.name}@${task.schedule}`)
  console.log(`registered: ${registered.join('  ')}`)
  assert.deepEqual(
    scheduler.tasks.map((task) => task.name),
    ['dispatch-outbound-emails', 'complete-elapsed-bookings', 'send-reminders'],
    'main.ts must register exactly the three jobs, in boot order',
  )
  assert.equal(scheduler.tasks[1]?.schedule, env.bookingJobsCron)
  assert.equal(scheduler.tasks[2]?.schedule, env.bookingJobsCron)
  console.log(
    `PASS 1: both S10 jobs are registrable with a valid cron ("${env.bookingJobsCron}" from BOOKING_JOBS_CRON)`,
  )

  // --- 2. a job with no schedule override defaults to the same env cron ------
  assert.equal(
    createCompleteElapsedBookingsJob(dataSource).schedule,
    env.bookingJobsCron,
    'complete-elapsed-bookings must default its schedule to BOOKING_JOBS_CRON',
  )
  assert.equal(
    createSendRemindersJob(dataSource).schedule,
    env.bookingJobsCron,
    'send-reminders must default its schedule to BOOKING_JOBS_CRON',
  )
  console.log(`PASS 2: both S10 jobs default their schedule to BOOKING_JOBS_CRON="${env.bookingJobsCron}"`)

  // --- 3. misconfiguration is a hard error, not a silently dead schedule -----
  assert.throws(
    () => createScheduler([noopJob('bad-cron', 'not a cron', () => undefined)]),
    /Invalid cron expression for bad-cron/,
    'an invalid cron expression must fail at registration',
  )
  assert.throws(
    () => createScheduler([noopJob('', '* * * * *', () => undefined)]),
    /must have a name/,
    'an unnamed job must fail at registration',
  )
  assert.throws(
    () =>
      createScheduler([
        noopJob('twice', '* * * * *', () => undefined),
        noopJob('twice', '* * * * *', () => undefined),
      ]),
    /Duplicate scheduled job name: twice/,
    'two jobs sharing a name would make the boot log lie about what is registered',
  )
  console.log('PASS 3: invalid cron, empty name and duplicate name are all rejected at registration')

  // --- 4. node-cron really fires it, and stop() really stops it -------------
  // A 6-field expression (with seconds) so this does not need a 60s wall clock.
  let fired = 0
  const ticking = createScheduler([noopJob('ticking', '*/1 * * * * *', () => { fired += 1 })])
  ticking.start()
  await sleep(2500)
  const firedWhileRunning = fired
  assert.ok(firedWhileRunning >= 1, `expected the scheduled job to fire, got ${String(firedWhileRunning)}`)
  await ticking.stop()
  await sleep(1500)
  assert.equal(
    fired,
    firedWhileRunning,
    `no further run may fire after stop() (${String(firedWhileRunning)} -> ${String(fired)})`,
  )
  console.log(
    `PASS 4: node-cron fired the registered job ${String(firedWhileRunning)}x in 2.5s, then stop() halted it (still ${String(fired)} after 1.5s more)`,
  )

  // --- 5. a rejected run is logged, not left as an unhandled rejection ------
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  const failing = createScheduler([
    {
      name: 'always-fails',
      schedule: '*/1 * * * * *',
      run: () => Promise.reject(new Error('boom')),
    },
  ])
  failing.start()
  await sleep(1500)
  await failing.stop()
  process.off('unhandledRejection', onUnhandled)
  assert.deepEqual(unhandled, [], 'a failing job must not become an unhandled promise rejection')
  console.log('PASS 5: a throwing job run is caught by the scheduler, not surfaced as an unhandled rejection')

  console.log('ALL SCHEDULER ACCEPTANCE TESTS PASSED')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
