import 'reflect-metadata'
import { createApp } from './app'
import { loadEnv } from './config/env'
import { createDataSource } from './config/data-source'
import { attachRealtimeGateway, createRealtimeGateway, SERVER_SHUTDOWN_CLOSE_CODE } from './realtime/gateway'
import { createEmailProvider } from './email/providers'
import { createCompleteElapsedBookingsJob } from './jobs/complete-elapsed-bookings.job'
import { createSendRemindersJob } from './jobs/send-reminders.job'
import { createDispatchOutboundEmailsJob } from './jobs/dispatch-outbound-emails.job'
import { createScheduler } from './jobs/scheduler'

async function main(): Promise<void> {
  const env = loadEnv()
  // PLAN.md's boot sequence: DataSource → schema → http server → ws gateway →
  // cron. Each step is awaited before the next begins, so the socket is not
  // accepting connections until the gateway that must claim '/ws' upgrades is
  // already attached.
  const dataSource = createDataSource()
  await dataSource.initialize()

  // createApp builds the schema and rewrites apps/server/schema.graphql, so
  // anything that can reach /graphql can trust that file (the C0 codegen input).
  const app = await createApp(dataSource)
  const server = app.listen(env.port)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      resolve()
    })
    server.once('error', reject)
  })
  console.log(`[${env.nodeEnv}] server listening on http://localhost:${env.port}/health`)
  // Past this point the boot-time reject above is gone; a later 'error' should
  // be reported, not surface as an unhandled event with a raw stack.
  server.on('error', (error: Error) => {
    console.error(`http server error: ${error.message}`)
  })

  // The realtime gateway shares the HTTP server's port and takes over the
  // 'upgrade' event for its own path only (ws://host:<port>/ws?token=...).
  const gateway = createRealtimeGateway(server, dataSource)
  attachRealtimeGateway(gateway)
  console.log(`[${env.nodeEnv}] realtime listening on ws://localhost:${env.port}${gateway.path}`)

  // FR-61: the outbox dispatcher. It only ever runs long after the booking
  // transactions it serves have committed, and it holds no booking state, so a
  // provider outage costs retries rather than data.
  const emailProvider = createEmailProvider(env)
  const emailJob = createDispatchOutboundEmailsJob(dataSource, emailProvider, {
    schedule: env.email.dispatchCron,
    maxAttempts: env.email.maxAttempts,
  })

  // S10: the two booking-clock jobs, on one shared cadence (BOOKING_JOBS_CRON,
  // see PLAN.md assumption #10). Both are plain callables first — the acceptance
  // suites drive them with an injected clock — and registered here last, after
  // the port is serving and the gateway has claimed '/ws', so the first tick
  // cannot race the boot.
  const completeElapsedJob = createCompleteElapsedBookingsJob(dataSource, {
    schedule: env.bookingJobsCron,
  })
  const sendRemindersJob = createSendRemindersJob(dataSource, {
    schedule: env.bookingJobsCron,
  })

  const scheduler = createScheduler([emailJob, completeElapsedJob, sendRemindersJob])
  scheduler.start()
  for (const task of scheduler.tasks) {
    console.log(`[${env.nodeEnv}] cron job "${task.name}" registered on "${task.schedule}"`)
  }
  console.log(
    `[${env.nodeEnv}] email dispatcher uses ${emailProvider.name} provider (max ${String(env.email.maxAttempts)} attempts)`,
  )

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`received ${signal}, shutting down`)
    // Order matters: stop accepting first (both plain HTTP and websocket
    // upgrades) so the port is released as early as possible. A watcher
    // restarting this process collides with :port if teardown of the below
    // runs before the listener is closed.
    attachRealtimeGateway(null)
    server.close()
    await scheduler.stop()
    await gateway.close(SERVER_SHUTDOWN_CLOSE_CODE, 'Server shutting down')
    await dataSource.destroy()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`failed to start server: ${message}`)
  process.exit(1)
})
