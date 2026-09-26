import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { In, Like } from 'typeorm'
import { createDataSource } from '../../config/data-source'
import { loadEnv, type Env } from '../../config/env'
import { runInTransaction } from '../../common/db/transaction'
import { Booking } from '../../modules/booking/booking.entity'
import { BookingEquipment } from '../../modules/booking/booking-equipment.entity'
import { BookingService } from '../../modules/booking/booking.service'
import { AuditLog } from '../../modules/audit/audit-log.entity'
import { Employee } from '../../modules/employee/employee.entity'
import { MeetingRoom } from '../../modules/room/room.entity'
import { Role } from '../../modules/rbac/role.entity'
import { UserRole } from '../../modules/rbac/user-role.entity'
import { Notification } from '../../modules/notification/notification.entity'
import { EmailOutbox } from '../email-outbox.entity'
import { EmailService } from '../email.service'
import { backoffMs, dispatchPendingEmails } from '../dispatcher'
import { createEmailProvider } from '../providers'
import { NoopProvider } from '../providers/noop.provider'
import { SendgridProvider } from '../providers/sendgrid.provider'
import type { EmailProvider, OutboundEmail } from '../email.types'
import { createDispatchOutboundEmailsJob } from '../../jobs/dispatch-outbound-emails.job'
import { createScheduler } from '../../jobs/scheduler'

const PASSWORD_HASH = '$2b$12$email.acceptance.password.hash.00000000000000000000000'

/** Records every message and can be told to fail, like a flaky transport. */
class RecordingProvider implements EmailProvider {
  readonly name: string
  readonly from: string
  readonly sent: OutboundEmail[] = []
  failuresRemaining = 0

  constructor(name: string, from: string) {
    this.name = name
    this.from = from
  }

  async send(message: OutboundEmail): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('provider unavailable (simulated)')
    }
    this.sent.push(message)
  }
}

function envWith(overrides: { apiKey?: string; emailFrom?: string; nodeEnv?: Env['nodeEnv'] }): Env {
  const base = loadEnv()
  return {
    ...base,
    nodeEnv: overrides.nodeEnv ?? base.nodeEnv,
    sendgrid: {
      apiKey: overrides.apiKey ?? '',
      emailFrom: overrides.emailFrom ?? '',
    },
  }
}

async function main(): Promise<void> {
  const dataSource = createDataSource()
  dataSource.setOptions({ logging: ['error'] })
  await dataSource.initialize()

  const runId = randomUUID().slice(0, 8)
  const employeeRepository = dataSource.getRepository(Employee)
  const roomRepository = dataSource.getRepository(MeetingRoom)
  const bookingRepository = dataSource.getRepository(Booking)
  const outboxRepository = dataSource.getRepository(EmailOutbox)
  const bookingIds: string[] = []
  const employeeIds: string[] = []
  let roomId: string | null = null
  // The outbox is shared state, so cleanup removes only rows this run created.
  const createdOutboxIds: string[] = []

  const fastOptions = { batchSize: 10, maxAttempts: 3, retryBaseMs: 1000, retryCapMs: 8000, leaseMs: 30_000 }

  // The dev server runs the real cron dispatcher on the same database, so this
  // test owns its rows through the dispatcher's injected clock: every row it
  // creates is due a week from now, which the live dispatcher (on the real
  // clock) can never claim, and every dispatch call here reads `clock`.
  let clock = new Date(Date.now() + 7 * 86400000)
  const dispatch = (provider: EmailProvider, overrides = {}) =>
    dispatchPendingEmails(dataSource, provider, { ...fastOptions, now: () => clock, ...overrides })
  const holdRow = async (id: string): Promise<void> => {
    createdOutboxIds.push(id)
    await outboxRepository.update({ id }, { nextAttemptAt: clock })
  }
  const advanceClockPast = async (id: string): Promise<void> => {
    clock = new Date(clock.getTime() + 3600000)
    await outboxRepository.update({ id }, { nextAttemptAt: new Date(clock.getTime() - 1000) })
  }

  try {
    const [requester, manager] = await employeeRepository.save([
      employeeRepository.create({
        firstName: `Ivy${runId}`,
        lastName: 'Requester',
        email: `ivy-${runId}@example.test`,
        password: PASSWORD_HASH,
      }),
      employeeRepository.create({
        firstName: `Ash${runId}`,
        lastName: 'Manager',
        email: `ash-${runId}@example.test`,
        password: PASSWORD_HASH,
      }),
    ])
    if (requester === undefined || manager === undefined) {
      throw new Error('Email employee fixture creation returned too few rows')
    }
    employeeIds.push(requester.id, manager.id)
    const managerRole = await dataSource.getRepository(Role).findOneByOrFail({ roleName: 'Manager' })
    await dataSource
      .getRepository(UserRole)
      .save(dataSource.getRepository(UserRole).create({ employeeId: manager.id, roleId: managerRole.id }))

    const room = await roomRepository.save(
      roomRepository.create({
        name: `Email room ${runId}`,
        location: `Lab ${runId}`,
        capacity: 20,
        isActive: true,
      }),
    )
    roomId = room.id

    const emailService = new EmailService()
    const bookingService = new BookingService(dataSource, undefined, undefined, undefined, emailService)
    let slot = 0
    const submit = async (employeeId: string, purpose: string) => {
      slot += 1
      const startTime = new Date(Date.now() + (40 + slot) * 86400000)
      const booking = await bookingService.createBooking(employeeId, {
        roomId: room.id,
        startTime,
        endTime: new Date(startTime.getTime() + 3600000),
        purpose,
        numberOfAttendees: 2,
      })
      bookingIds.push(booking.id)
      return booking
    }
    // --- 0. which provider is active, and what the config decides ----------
    const activeProvider = createEmailProvider(loadEnv())
    const noopWhenUnset = createEmailProvider(envWith({}))
    const sendgridWhenSet = createEmailProvider(envWith({ apiKey: 'SG.test', emailFrom: 'no-reply@example.test' }))
    let productionThrew = ''
    try {
      createEmailProvider(envWith({ nodeEnv: 'production' }))
    } catch (error) {
      productionThrew = error instanceof Error ? error.message : String(error)
    }
    assert.ok(activeProvider instanceof NoopProvider || activeProvider instanceof SendgridProvider)
    assert.equal(noopWhenUnset.name, 'noop')
    assert.equal(sendgridWhenSet.name, 'sendgrid')
    assert.equal(sendgridWhenSet.from, 'no-reply@example.test')
    assert.match(productionThrew, /NODE_ENV=production/)
    console.log(
      `0. provider selection: live=${activeProvider.name} (SENDGRID_API_KEY empty -> noop) unsetKey=${noopWhenUnset.name} withKey=${sendgridWhenSet.name} productionWithoutKey="refused"`,
    )

    // --- 1. approval queues an outbox row, in its own transaction ----------
    const outboxBefore = await outboxRepository.count()
    const approvedPurpose = `Email approved ${runId}`
    const approveTarget = await submit(requester.id, approvedPurpose)
    const approvedBooking = await bookingService.approveBooking(manager.id, approveTarget.id)
    assert.equal(approvedBooking.status, 'APPROVED')
    // Scoped to this run's recipient: a crashed earlier run can leave rows
    // behind, and createdAt has second resolution so DESC is not a safe tiebreak.
    const approvalOutbox = await outboxRepository.findOneOrFail({
      where: { eventType: 'BOOKING_APPROVED', toEmail: requester.email },
    })
    await holdRow(approvalOutbox.id)
    assert.equal(approvalOutbox.toEmail, requester.email, 'the recipient is the requester, not the manager')
    assert.equal(approvalOutbox.status, 'PENDING')
    assert.equal(approvalOutbox.attempts, 0)
    assert.equal(approvalOutbox.sentAt, null)
    assert.match(approvalOutbox.subject, /was approved/)
    assert.ok(approvalOutbox.subject.includes(approvedPurpose))
    assert.ok(approvalOutbox.html.includes(approvedPurpose))
    assert.ok(approvalOutbox.html.includes(requester.firstName), 'the body addresses the requester by name')
    assert.equal(await outboxRepository.count(), outboxBefore + 1, 'exactly one email per decision')
    // The enqueue runs in a post-commit transaction, so the booking and its
    // audit row are already durable by the time the outbox row exists.
    const bookingNow = await bookingRepository.findOneByOrFail({ id: approveTarget.id })
    assert.equal(bookingNow.status, 'APPROVED')
    const auditRows = await dataSource.getRepository(AuditLog).count({ where: { bookingId: approveTarget.id } })
    assert.ok(auditRows >= 2, 'approval and its audit row are already committed')
    console.log(
      `1. approval enqueues: to=${approvalOutbox.toEmail} template=${approvalOutbox.eventType} status=${approvalOutbox.status} attempts=${approvalOutbox.attempts} sentAt=${String(approvalOutbox.sentAt)} bookingStatus=${bookingNow.status} committedAudits=${auditRows} (post-commit tx)`,
    )

    // --- 1b. a rolled-back decision queues nothing -------------------------
    const rejectedByRollback = await submit(requester.id, `Email rollback ${runId}`)
    await roomRepository.update({ id: room.id }, { isActive: false })
    const beforeRollback = await outboxRepository.count()
    const rollbackError = await bookingService
      .approveBooking(manager.id, rejectedByRollback.id)
      .then(() => 'no error')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    await roomRepository.update({ id: room.id }, { isActive: true })
    assert.match(rollbackError, /inactive/)
    assert.equal(
      await outboxRepository.count(),
      beforeRollback,
      'a rolled-back approval must not leave an outbox row',
    )
    assert.equal((await bookingRepository.findOneByOrFail({ id: rejectedByRollback.id })).status, 'PENDING')
    console.log(
      `1b. rolled-back decision: error="${rollbackError}" outboxRowsAdded=0 bookingStill=${(await bookingRepository.findOneByOrFail({ id: rejectedByRollback.id })).status}`,
    )

    // --- 1c. the row participates in the caller's transaction ---------------
    const rollbackProbe = await runInTransaction(dataSource, async (manager) => {
      const enqueued = await emailService.enqueue(manager, {
        to: requester.email,
        template: 'BOOKING_REMINDER',
        data: {
          employeeName: `${requester.firstName} ${requester.lastName}`,
          purpose: `probe ${runId}`,
          roomName: room.name,
          startTime: new Date(Date.now() + 86400000).toISOString(),
          endTime: new Date(Date.now() + 90000000).toISOString(),
        },
      })
      throw new Error(`probe rollback ${enqueued.id}`)
    }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    assert.match(rollbackProbe, /probe rollback/)
    assert.equal(
      await outboxRepository.count({ where: { subject: `Reminder: your booking "probe ${runId}" is coming up` } }),
      0,
      'enqueue must roll back with its caller, proving it opens no transaction of its own',
    )
    console.log(
      `1c. enqueue transaction membership: callerRolledBack=true probeRowsRemaining=0 ("${String(rollbackProbe).slice(0, 24)}...")`,
    )

    // --- 1d. rejection queues its own template with the reason ------------
    const toReject = await submit(requester.id, `Email rejected ${runId}`)
    await bookingService.rejectBooking(manager.id, toReject.id, 'room is reserved for the all-hands')
    const rejectionRow = await outboxRepository.findOneOrFail({
      where: { eventType: 'BOOKING_REJECTED', toEmail: requester.email },
    })
    await holdRow(rejectionRow.id)
    assert.equal(rejectionRow.toEmail, requester.email)
    assert.match(rejectionRow.subject, /was rejected/)
    assert.ok(rejectionRow.html.includes('room is reserved for the all-hands'))
    console.log(
      `1d. rejection enqueues: to=${rejectionRow.toEmail} template=${rejectionRow.eventType} reasonInBody=true`,
    )

    // --- 2. the dispatcher sends a pending row via the noop provider -------
    const noop = new NoopProvider()
    const firstRun = await dispatch(noop)
    const sentRow = await outboxRepository.findOneByOrFail({ id: approvalOutbox.id })
    assert.equal(sentRow.status, 'SENT')
    assert.equal(sentRow.attempts, 1)
    assert.equal(sentRow.lastError, null)
    assert.notEqual(sentRow.sentAt, null)
    assert.equal(noop.sent.length, firstRun.sent)
    assert.equal(noop.sent[0]?.outboxId, sentRow.id)
    assert.equal(noop.sent[0]?.to, requester.email)
    assert.equal(noop.sent[0]?.subject, approvalOutbox.subject)
    assert.equal(noop.sent[0]?.html, approvalOutbox.html)
    console.log(
      `2. dispatch: claimed=${firstRun.claimed} sent=${firstRun.sent} failed=${firstRun.failed} row=${sentRow.id.slice(0, 8)} status=${sentRow.status} attempts=${sentRow.attempts} sentAt=${sentRow.sentAt?.toISOString() ?? 'null'} provider=${noop.name}`,
    )

    // --- 3. a throwing provider retries, and the booking stays APPROVED ----
    // A fresh decision, so there is a row the failing provider can actually get.
    const failingTarget = await submit(requester.id, `Email failing send ${runId}`)
    const failingBooking = await bookingService.approveBooking(manager.id, failingTarget.id)
    assert.equal(failingBooking.status, 'APPROVED')
    const failingRow = await outboxRepository.findOneOrFail({
      where: { eventType: 'BOOKING_APPROVED', toEmail: requester.email, subject: Like(`%Email failing send%`) },
    })
    await holdRow(failingRow.id)
    const flaky = new RecordingProvider('flaky', 'no-reply@example.test')
    flaky.failuresRemaining = 1
    const failingRun = await dispatch(flaky)
    const failedRow = await outboxRepository.findOneByOrFail({ id: failingRow.id })
    assert.equal(failingRun.sent, 0, 'a throwing provider sends nothing')
    assert.equal(failingRun.failed, 1)
    assert.equal(flaky.sent.length, 0)
    assert.equal(failedRow.status, 'PENDING', 'still retryable under the attempt ceiling')
    assert.equal(failedRow.attempts, 1)
    assert.match(failedRow.lastError ?? '', /provider unavailable \(simulated\)/)
    assert.notEqual(failedRow.nextAttemptAt, null, 'a retry must be scheduled')
    const expectedBackoff = backoffMs(1, fastOptions.retryBaseMs, fastOptions.retryCapMs)
    const scheduledIn = (failedRow.nextAttemptAt?.getTime() ?? 0) - clock.getTime()
    assert.ok(
      scheduledIn >= expectedBackoff - 50 && scheduledIn <= expectedBackoff + 50,
      `retry scheduled in ${String(scheduledIn)}ms, expected about ${String(expectedBackoff)}ms`,
    )
    const stillApproved = await bookingRepository.findOneByOrFail({ id: failingTarget.id })
    assert.equal(stillApproved.status, 'APPROVED', 'a failed send never rolls back the booking')
    const alsoStillApproved = await bookingRepository.findOneByOrFail({ id: approveTarget.id })
    assert.equal(alsoStillApproved.status, 'APPROVED')
    console.log(
      `3. provider failure: summary.sent=${failingRun.sent} summary.failed=${failingRun.failed} row=${failedRow.id.slice(0, 8)} status=${failedRow.status} attempts=${failedRow.attempts} lastError="${String(failedRow.lastError)}" retryIn≈${String(scheduledIn)}ms bookingStill=${stillApproved.status} (not rolled back)`,
    )

    // --- 3b. a row inside its backoff window is left alone ---------------
    const duringBackoff = await dispatch(flaky)
    assert.equal(duringBackoff.claimed, 0, 'a row scheduled for the future must not be claimed')
    assert.equal(flaky.sent.length, 0)
    console.log(
      `3b. backoff respected: claimed=${duringBackoff.claimed} sent=${duringBackoff.sent} (row not yet due)`,
    )

    // --- 3c. attempts are exhausted into FAILED, still no booking damage ---
    flaky.failuresRemaining = 5
    await advanceClockPast(failedRow.id)
    await dispatch(flaky)
    await advanceClockPast(failedRow.id)
    const finalFailure = await dispatch(flaky)
    const deadRow = await outboxRepository.findOneByOrFail({ id: failedRow.id })
    assert.equal(deadRow.status, 'FAILED')
    assert.equal(deadRow.attempts, fastOptions.maxAttempts)
    assert.equal(deadRow.nextAttemptAt, null, 'an exhausted row stops being scheduled')
    assert.equal(finalFailure.deadLettered, 1)
    assert.equal((await bookingRepository.findOneByOrFail({ id: failingTarget.id })).status, 'APPROVED')
    console.log(
      `3c. exhausted: status=${deadRow.status} attempts=${deadRow.attempts}/${String(fastOptions.maxAttempts)} nextAttemptAt=null deadLettered=${finalFailure.deadLettered} bookingStill=${(await bookingRepository.findOneByOrFail({ id: failingTarget.id })).status}`,
    )

    // --- 4. running the dispatcher twice never resends a SENT row ---------
    const noopCallsBefore = noop.sent.length
    const secondRun = await dispatch(noop)
    const thirdRun = await dispatch(noop)
    assert.equal(secondRun.claimed, 0)
    assert.equal(thirdRun.claimed, 0)
    assert.equal(noop.sent.length, noopCallsBefore, 'an already-sent row is never sent again')
    assert.equal((await outboxRepository.findOneByOrFail({ id: approvalOutbox.id })).attempts, 1)
    console.log(
      `4. idempotency: run1.claimed=${firstRun.claimed} run2.claimed=${secondRun.claimed} run3.claimed=${thirdRun.claimed} providerSendsUnchanged=${noop.sent.length === noopCallsBefore} sentRowAttemptsStill=1`,
    )

    // --- 5. the cron job runs the same dispatcher ------------------------
    // A user-supplied purpose reaches a mail header, so it must not be able to
    // smuggle CR/LF (or angle brackets) into the subject or the HTML body.
    const injection = `Team sync\r\nBcc: attacker@evil.test\r\n<script>alert(1)</script>`
    const injected = await emailService.enqueue(dataSource.manager, {
      to: requester.email,
      template: 'BOOKING_APPROVED',
      data: {
        employeeName: `${requester.firstName} ${requester.lastName}`,
        purpose: injection,
        roomName: room.name,
        startTime: new Date(Date.now() + 3600000).toISOString(),
        endTime: new Date(Date.now() + 7200000).toISOString(),
      },
    })
    // The dangerous part is the line break, not the word: without CR/LF there
    // is no way to start a new header, so "Bcc:" survives as harmless text.
    assert.ok(!/[\r\n]/.test(injected.subject), 'the subject must stay on one line')
    assert.equal(injected.subject.split('\n').length, 1)
    await holdRow(injected.id)
    assert.ok(!injected.html.includes('<script>'), 'html body must be escaped')
    assert.ok(injected.html.includes('&lt;script&gt;'))
    console.log(
      `4b. header safety: subject="${injected.subject}" singleLine=true scriptEscaped=${injected.html.includes('&lt;script&gt;')}`,
    )

    const jobProvider = new RecordingProvider('job-noop', 'no-reply@example.test')
    const job = createDispatchOutboundEmailsJob(dataSource, jobProvider, {
      schedule: '*/5 * * * *',
      maxAttempts: 3,
      now: () => clock,
    })
    const scheduler = createScheduler([job])
    assert.equal(scheduler.tasks[0]?.schedule, '*/5 * * * *')
    // FR-74 reminders are S10's job to enqueue; queue one directly here so the
    // cron path has real work to do.
    const reminder = await emailService.enqueue(dataSource.manager, {
      to: requester.email,
      template: 'BOOKING_REMINDER',
      data: {
        employeeName: `${requester.firstName} ${requester.lastName}`,
        purpose: `Email reminder ${runId}`,
        roomName: room.name,
        startTime: new Date(Date.now() + 3600000).toISOString(),
        endTime: new Date(Date.now() + 7200000).toISOString(),
      },
    })
    await holdRow(reminder.id)
    assert.equal(reminder.status, 'PENDING')
    const jobSummary = await job.run()
    scheduler.start()
    scheduler.stop()
    assert.ok(jobSummary.claimed >= 1, 'the cron run must find the queued reminders')
    assert.equal(jobSummary.sent, jobSummary.claimed, 'the cron run sends everything it claimed')
    assert.equal(jobSummary.failed, 0)
    assert.equal(
      jobProvider.sent.filter((message) => message.eventType === 'BOOKING_REMINDER').length,
      1,
    )
    const reminderRow = await outboxRepository.findOneByOrFail({ id: reminder.id })
    assert.equal(reminderRow.status, 'SENT')
    assert.equal(reminderRow.attempts, 1)
    console.log(
      `5. cron job: schedule="${job.schedule}" provider=${jobProvider.name} claimed=${jobSummary.claimed} sent=${jobSummary.sent} reminderRowStatus=${reminderRow.status} started+stoppedWithoutError=true`,
    )

    console.log('PASS email acceptance')
  } finally {
    const manager = dataSource.manager
    // Notifications first: notification.booking_id is ON DELETE RESTRICT. They
    // are addressed to seeded approvers too, so scope by booking, not recipient.
    if (bookingIds.length > 0) {
      await manager.getRepository(Notification).delete({ bookingId: In(bookingIds) })
      await manager.getRepository(BookingEquipment).delete({ bookingId: In(bookingIds) })
      await manager.getRepository(AuditLog).delete({ bookingId: In(bookingIds) })
      await manager.getRepository(Booking).delete({ id: In(bookingIds) })
    }
    if (createdOutboxIds.length > 0) {
      await manager.getRepository(EmailOutbox).delete({ id: In(createdOutboxIds) })
    }
    if (employeeIds.length > 0) {
      await manager.getRepository(UserRole).delete({ employeeId: In(employeeIds) })
      await employeeRepository.delete({ id: In(employeeIds) })
    }
    if (roomId !== null) {
      await roomRepository.delete({ id: roomId })
    }
    await dataSource.destroy()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(`FAIL email acceptance\n${message}`)
  process.exit(1)
})
