import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { DataSource, EntityManager } from 'typeorm'
import { createDataSource } from '../../config/data-source'
import { loadEnv } from '../../config/env'
import { AuditLog } from '../../modules/audit/audit-log.entity'
import { Booking } from '../../modules/booking/booking.entity'
import { Employee } from '../../modules/employee/employee.entity'
import { MeetingRoom } from '../../modules/room/room.entity'
import { NotificationService } from '../../modules/notification/notification.service'
import { UserRole } from '../../modules/rbac/user-role.entity'
import { createSendRemindersJob } from '../send-reminders.job'
import type { BookingStatus } from '@resource-booking/shared'

const MINUTE = 60 * 1000
const LEAD_MINUTES = 60

type ReminderRow = {
  id: string
  recipient_id: string
  booking_id: string
  type: string
  title: string
  message: string
  is_read: boolean
}

type OutboxRow = {
  id: string
  to_email: string
  subject: string
  event_type: string
  status: string
}

async function remindersFor(manager: EntityManager, bookingId: string): Promise<ReminderRow[]> {
  return (await manager.query(
    `SELECT id, recipient_id, booking_id, type, title, message, is_read
     FROM notification
     WHERE booking_id = $1 AND type = 'REMINDER'
     ORDER BY created_at ASC, id ASC`,
    [bookingId],
  )) as ReminderRow[]
}

async function allReminders(manager: EntityManager): Promise<ReminderRow[]> {  return (await manager.query(
    `SELECT id, recipient_id, booking_id, type, title, message, is_read
     FROM notification
     WHERE type = 'REMINDER'
     ORDER BY created_at ASC, id ASC`,
  )) as ReminderRow[]
}

async function bookingStatus(manager: EntityManager, bookingId: string): Promise<BookingStatus> {
  const rows = (await manager.query('SELECT status FROM booking WHERE id = $1', [bookingId])) as Array<{
    status: BookingStatus
  }>
  const status = rows[0]?.status
  assert.ok(status, `booking ${bookingId} vanished`)
  return status
}

async function outboxFor(manager: EntityManager, toEmail: string): Promise<OutboxRow[]> {
  return (await manager.query(
    `SELECT id, to_email, subject, event_type, status
     FROM email_outbox
     WHERE to_email = $1
     ORDER BY created_at ASC, id ASC`,
    [toEmail],
  )) as OutboxRow[]
}

async function main(): Promise<void> {
  // `createDataSource` turns SQL logging on for NODE_ENV=development, which
  // drowns the suite's own PASS lines.
  process.env.NODE_ENV = 'test'
  const dataSource: DataSource = createDataSource()
  await dataSource.initialize()
  const manager = dataSource.manager

  const runId = randomUUID()
  const roomIds: string[] = []
  const employeeIds: string[] = []
  const bookingIds: string[] = []

  try {
    const env = loadEnv()
    assert.equal(
      env.reminderLeadTimeMinutes,
      Number(process.env.REMINDER_LEAD_TIME_MINUTES ?? 60),
      'env must expose REMINDER_LEAD_TIME_MINUTES',
    )
    assert.ok(env.reminderLeadTimeMinutes > 0, 'REMINDER_LEAD_TIME_MINUTES must be positive')
    console.log(
      `REMINDER_LEAD_TIME_MINUTES from env = ${String(env.reminderLeadTimeMinutes)} (job run injects ${String(LEAD_MINUTES)})`,
    )

    const employeeRepository = manager.getRepository(Employee)
    const roomRepository = manager.getRepository(MeetingRoom)
    const bookingRepository = manager.getRepository(Booking)
    const userRoleRepository = manager.getRepository(UserRole)

    const roleRows = (await manager.query(
      "SELECT role_name, id FROM role WHERE role_name = 'Employee'",
    )) as Array<{ role_name: string; id: string }>
    const employeeRoleId = roleRows[0]?.id
    assert.ok(employeeRoleId, 'Employee role required')

    const requester = await employeeRepository.save(
      employeeRepository.create({
        firstName: `Reminded${runId}`,
        lastName: 'Test',
        email: `reminded-${runId}@resource.local`,
        password: 'hash',
      }),
    )
    employeeIds.push(requester.id)
    await userRoleRepository.save(userRoleRepository.create({ employeeId: requester.id, roleId: employeeRoleId }))

    // Each fixture gets its own room, so the `ex_booking_room_time_range`
    // exclusion constraint (PENDING/APPROVED only) can never make two collide.
    const makeRoom = async (label: string): Promise<MeetingRoom> => {
      const room = await roomRepository.save(
        roomRepository.create({
          name: `Reminder ${label} ${runId}`,
          location: 'Test',
          capacity: 10,
          isActive: true,
        }),
      )
      roomIds.push(room.id)
      return room
    }

    // The window is parked 10 years out: nothing else in the shared dev database
    // books a meeting that far ahead, so `scanned` is this suite's own count and
    // can be asserted exactly.
    const windowStart = new Date(Date.now() + 3650 * 24 * 60 * MINUTE)
    const clock = (): Date => windowStart
    const inWindow = (minutesFromNow: number): Date => new Date(windowStart.getTime() + minutesFromNow * MINUTE)

    const makeBooking = async (
      label: string,
      startTime: Date,
      status: BookingStatus,
      requesterId: string | null,
    ): Promise<Booking> => {
      const room = await makeRoom(label)
      const booking = await bookingRepository.save(
        bookingRepository.create({
          employeeId: requesterId,
          roomId: room.id,
          startTime,
          endTime: new Date(startTime.getTime() + 30 * MINUTE),
          purpose: `FR-74 reminder ${label}`,
          rejectionReason: null,
          numberOfAttendees: 1,
          status,
        }),
      )
      bookingIds.push(booking.id)
      return booking
    }

    // --- fixtures -----------------------------------------------------------
    // +10min, APPROVED -> reminder-worthy (checks 1 and 2)
    const dueApproved = await makeBooking('due-approved', inWindow(10), 'APPROVED', requester.id)
    // +30min, PENDING -> reminder-worthy, independent of the first (check 5)
    const duePending = await makeBooking('due-pending', inWindow(30), 'PENDING', requester.id)
    // +6h -> outside the 60-minute lead time (check 3)
    const outside = await makeBooking('outside-lead-time', inWindow(6 * 60), 'APPROVED', requester.id)
    // terminal statuses inside the window -> not reminder-worthy (check 4)
    const cancelled = await makeBooking('cancelled', inWindow(20), 'CANCELLED', requester.id)
    const rejected = await makeBooking('rejected', inWindow(25), 'REJECTED', requester.id)
    const completed = await makeBooking('completed', inWindow(35), 'COMPLETED', requester.id)
    // +15min but the requester was hard-deleted (FR-7) -> nobody to notify
    const orphaned = await makeBooking('orphaned-requester', inWindow(15), 'APPROVED', null)

    console.log(
      `window = [${windowStart.toISOString()}, ${inWindow(LEAD_MINUTES).toISOString()}] ` +
        `(now = ${windowStart.toISOString()}, lead = ${String(LEAD_MINUTES)}min)`,
    )
    console.log(
      `fixtures: dueApproved=${dueApproved.id} (+10m APPROVED), duePending=${duePending.id} (+30m PENDING), ` +
        `outside=${outside.id} (+6h APPROVED), cancelled=${cancelled.id}, rejected=${rejected.id}, ` +
        `completed=${completed.id}, orphaned=${orphaned.id} (+15m APPROVED, employeeId NULL)`,
    )

    // Precondition: nothing in the suite's window has been reminded yet.
    assert.deepEqual(await remindersFor(manager, dueApproved.id), [], 'precondition: no REMINDER yet')
    assert.deepEqual(await remindersFor(manager, duePending.id), [], 'precondition: no REMINDER yet')
    console.log('precondition: zero REMINDER notifications for the two due fixtures')

    // --- run 1 --------------------------------------------------------------
    const job = createSendRemindersJob(dataSource, { now: clock, leadTimeMinutes: LEAD_MINUTES })
    const first = await job.run()
    console.log(
      `run 1: scanned=${String(first.scanned)} created=${String(first.created)} ` +
        `delivered=${String(first.delivered)} skippedNoRecipient=${String(first.skippedNoRecipient)} ` +
        `skippedAlreadyReminded=${String(first.skippedAlreadyReminded)} failed=${String(first.failed.length)}`,
    )
    assert.deepEqual(first.failed, [], 'run 1 must not fail any booking')
    assert.equal(first.delivered, 0, 'no websocket gateway is attached, so nothing is delivered')
    assert.equal(first.skippedAlreadyReminded, 0, 'nothing is reminded yet, so nothing is skipped for that')

    // --- check 1: a due booking with no REMINDER gets exactly one ------------
    const dueApprovedReminders = await remindersFor(manager, dueApproved.id)
    assert.equal(
      dueApprovedReminders.length,
      1,
      `expected exactly one REMINDER for the due APPROVED booking, got ${String(dueApprovedReminders.length)}`,
    )
    const reminder = dueApprovedReminders[0]
    assert.equal(reminder?.type, 'REMINDER')
    assert.equal(reminder?.booking_id, dueApproved.id)
    assert.equal(
      reminder?.recipient_id,
      requester.id,
      'the reminder must be addressed to the booking requester',
    )
    assert.equal(reminder?.is_read, false, 'a fresh reminder is unread')
    assert.equal(reminder?.title, 'Upcoming booking reminder')
    assert.ok(
      reminder?.message.includes('FR-74 reminder due-approved'),
      `reminder must name the booking, got: ${String(reminder?.message)}`,
    )
    assert.ok(
      reminder?.message.includes(inWindow(10).toISOString()),
      `reminder must state the start time, got: ${String(reminder?.message)}`,
    )
    console.log(
      `PASS 1: due APPROVED booking got exactly 1 REMINDER (recipient=${requester.id}, unread) — "${String(reminder?.message)}"`,
    )

    // FR-61 names "upcoming-booking reminder events" as an emailed event, and
    // BOOKING_REMINDER is an S9 template with no producer until this job.
    const outbox = await outboxFor(manager, requester.email)
    assert.equal(
      outbox.length,
      2,
      `expected one outbox row per reminder (2 reminders), got ${String(outbox.length)}`,
    )
    assert.ok(
      outbox.every((row) => row.event_type === 'BOOKING_REMINDER'),
      `every outbox row must be a reminder email, got ${outbox.map((r) => r.event_type).join(', ')}`,
    )
    assert.ok(
      outbox.every((row) => row.status === 'PENDING'),
      'outbox rows are pending; the dispatcher owns the send',
    )
    const dueApprovedRow = outbox.find((row) => row.subject.includes('FR-74 reminder due-approved'))
    assert.ok(dueApprovedRow, `no outbox row names the due booking, subjects: ${outbox.map((r) => r.subject).join(' | ')}`)
    console.log(
      `PASS 1b: FR-61 outbox row BOOKING_REMINDER queued (status=PENDING), subject="${String(dueApprovedRow?.subject)}"`,
    )

    // The reminder is visible to the requester through the S9 read surface too.
    const notificationService = new NotificationService()
    const listed = await notificationService.list(
      manager,
      requester.id,
      { page: 1, pageSize: 50 },
      null,
      { type: 'REMINDER' },
    )
    assert.equal(listed.totalCount, 2, `S9 list must show both reminders, got ${String(listed.totalCount)}`)
    assert.equal(
      await notificationService.unreadCount(manager, requester.id),
      2,
      'both reminders count towards the requester unread count',
    )
    console.log('PASS 1c: the S9 read surface lists 2 REMINDER rows and unreadCount=2')

    // --- check 3: outside the lead time -> no reminder -----------------------
    assert.deepEqual(
      await remindersFor(manager, outside.id),
      [],
      'a booking starting beyond the lead time must not be reminded',
    )
    console.log('PASS 3: APPROVED +6h (outside the 60-minute lead time) got no REMINDER')

    // --- check 4: terminal statuses inside the window -> no reminder ---------
    for (const [label, booking] of [
      ['CANCELLED', cancelled],
      ['REJECTED', rejected],
      ['COMPLETED', completed],
    ] as Array<[string, Booking]>) {
      assert.deepEqual(
        await remindersFor(manager, booking.id),
        [],
        `a ${label} booking must not be reminded, however soon it starts`,
      )
      console.log(`PASS 4: ${label} +inside-window got no REMINDER (only PENDING/APPROVED are reminder-worthy)`)
    }

    // FR-7: a hard-deleted requester is counted, not crashed on.
    assert.equal(first.skippedNoRecipient, 1, 'the orphaned booking must be counted as skippedNoRecipient')
    assert.deepEqual(await remindersFor(manager, orphaned.id), [], 'no recipient means no notification')
    console.log('PASS 4b: APPROVED booking whose requester was hard-deleted (FR-7) skipped, not crashed')

    // --- check 5: two due bookings are independent ---------------------------
    const duePendingReminders = await remindersFor(manager, duePending.id)
    assert.equal(
      duePendingReminders.length,
      1,
      `the second due booking must get its own single REMINDER, got ${String(duePendingReminders.length)}`,
    )
    assert.equal(duePendingReminders[0]?.booking_id, duePending.id)
    assert.notEqual(
      duePendingReminders[0]?.id,
      reminder?.id,
      'the two reminders must be distinct rows, not one row reused',
    )
    assert.deepEqual(
      await remindersFor(manager, dueApproved.id),
      dueApprovedReminders,
      "reminding the second booking must not disturb the first's single row",
    )
    console.log('PASS 5: two due bookings (+10m APPROVED, +30m PENDING) each got exactly 1 independent REMINDER')

    // --- check 2: FR-75 idempotency by literal repeated execution -----------
    const remindersAfterFirstRun = await allReminders(manager)
    const outboxAfterFirstRun = await outboxFor(manager, requester.email)
    console.log(
      `after run 1: REMINDER notifications=${String(remindersAfterFirstRun.length)}, ` +
        `outbox rows for requester=${String(outboxAfterFirstRun.length)}`,
    )

    const second = await job.run()
    const third = await job.run()
    const remindersAfterThirdRun = await allReminders(manager)
    const outboxAfterThirdRun = await outboxFor(manager, requester.email)

    console.log(
      `run 2: scanned=${String(second.scanned)} created=${String(second.created)} ` +
        `skippedNoRecipient=${String(second.skippedNoRecipient)} ` +
        `skippedAlreadyReminded=${String(second.skippedAlreadyReminded)} failed=${String(second.failed.length)}`,
    )
    console.log(
      `run 3: scanned=${String(third.scanned)} created=${String(third.created)} ` +
        `skippedNoRecipient=${String(third.skippedNoRecipient)} ` +
        `skippedAlreadyReminded=${String(third.skippedAlreadyReminded)} failed=${String(third.failed.length)}`,
    )

    // The only booking still in the scan is the orphaned one: it can never gain a
    // REMINDER (there is no recipient), so the NOT EXISTS filter never retires it.
    // Re-examining a no-op candidate every run is the correct price of never
    // silently hiding the FR-7 case from the summary.
    assert.equal(second.scanned, 1, 'run 2 must re-examine only the orphaned booking')
    assert.equal(second.skippedNoRecipient, 1, 'that candidate is the FR-7 orphan')
    assert.equal(second.created, 0, 'run 2 must create no REMINDER for the same booking')
    assert.equal(second.skippedAlreadyReminded, 0, 'the NOT EXISTS filter already removed the reminded bookings')
    assert.equal(third.scanned, 1)
    assert.equal(third.skippedNoRecipient, 1)
    assert.equal(third.created, 0, 'run 3 must create nothing')
    assert.equal(third.skippedAlreadyReminded, 0)
    assert.deepEqual(second.failed, [])
    assert.deepEqual(third.failed, [])
    assert.deepEqual(
      remindersAfterThirdRun.map((row) => row.id),
      remindersAfterFirstRun.map((row) => row.id),
      'three runs over the same window must leave the REMINDER set byte-identical',
    )
    assert.equal(outboxAfterThirdRun.length, outboxAfterFirstRun.length, 'no duplicate reminder emails either')
    assert.equal(
      (await remindersFor(manager, dueApproved.id)).length,
      1,
      'the first due booking still has exactly one REMINDER after three runs',
    )
    console.log(
      `PASS 2: runs 2 and 3 created 0 notifications and wrote 0 new outbox rows ` +
        `(REMINDER rows still ${String(remindersAfterThirdRun.length)}, outbox still ${String(outboxAfterThirdRun.length)}; ` +
        `the only re-scanned candidate each time is the FR-7 orphan) ` +
        '— FR-75 proven by literal repeated execution',
    )

    // The reminder job writes notifications only: it must never touch a booking's
    // status or its audit trail, and it never marks anything read.
    const auditRows = await manager.getRepository(AuditLog).count({
      where: bookingIds.map((id) => ({ bookingId: id })),
    })
    assert.equal(auditRows, 0, `the reminder job must write no audit rows, found ${String(auditRows)}`)
    assert.equal(
      await bookingStatus(manager, duePending.id),
      'PENDING',
      'the PENDING fixture is untouched by the job',
    )
    assert.equal(
      await bookingStatus(manager, dueApproved.id),
      'APPROVED',
      'the APPROVED fixture is untouched by the job',
    )
    const unreadRows = (await manager.query(
      'SELECT COUNT(*)::int AS unread FROM notification WHERE booking_id = ANY($1) AND is_read = false',
      [bookingIds],
    )) as Array<{ unread: number }>
    assert.equal(
      unreadRows[0]?.unread,
      2,
      'reminders stay unread; only the requester can mark them read',
    )
    console.log('PASS 6: no booking status change, no audit row, reminders remain unread')

    // Constructing without an explicit lead time takes it from the env config.
    assert.doesNotThrow(
      () => createSendRemindersJob(dataSource),
      'the job must default its lead time to REMINDER_LEAD_TIME_MINUTES',
    )
    assert.throws(
      () => createSendRemindersJob(dataSource, { leadTimeMinutes: 0 }),
      /REMINDER_LEAD_TIME_MINUTES must be a positive number/,
      'a non-positive lead time is a configuration error, not a silent no-op',
    )
    console.log('PASS 7: lead time defaults to env config; a non-positive lead time is rejected')

    // --- the FR-75 backstop, under a real race -------------------------------
    // A third due booking, then two overlapping runs. Whichever interleaving the
    // scheduler picks, the observable outcome is the same: exactly one REMINDER,
    // and the two summaries' `created` values sum to 1. There are three ways the
    // loser is stopped, and which one fires is timing-dependent: its scan-time
    // NOT EXISTS never lists the booking, or its in-transaction `hasReminder`
    // sees the winner's commit (skippedAlreadyReminded), or both pass the check
    // and the S1 unique index on (booking_id, recipient_id, type) rejects it with
    // a ConflictError that the job also counts as skippedAlreadyReminded rather
    // than a failure.
    const raceBooking = await makeBooking('race', inWindow(45), 'APPROVED', requester.id)
    const [raceA, raceB] = await Promise.all([job.run(), job.run()])
    console.log(
      `race: runA scanned=${String(raceA.scanned)} created=${String(raceA.created)} ` +
        `skippedAlreadyReminded=${String(raceA.skippedAlreadyReminded)} failed=${String(raceA.failed.length)} | ` +
        `runB scanned=${String(raceB.scanned)} created=${String(raceB.created)} ` +
        `skippedAlreadyReminded=${String(raceB.skippedAlreadyReminded)} failed=${String(raceB.failed.length)}`,
    )
    const raceReminders = await remindersFor(manager, raceBooking.id)
    assert.equal(
      raceReminders.length,
      1,
      `two overlapping runs must still yield exactly one REMINDER, got ${String(raceReminders.length)}`,
    )
    assert.equal(
      raceA.created + raceB.created,
      1,
      `exactly one of the overlapping runs may report a creation, got ${String(raceA.created)} + ${String(raceB.created)}`,
    )
    assert.deepEqual(raceA.failed, [], 'losing the unique-index race is not a failure')
    assert.deepEqual(raceB.failed, [], 'losing the unique-index race is not a failure')
    assert.ok(
      raceA.skippedAlreadyReminded + raceB.skippedAlreadyReminded <= 1,
      'at most one run can lose the race for a single booking',
    )
    const raceOutbox = await outboxFor(manager, requester.email)
    assert.equal(
      raceOutbox.filter((row) => row.subject.includes('FR-74 reminder race')).length,
      1,
      'the losing run must not queue a duplicate reminder email either',
    )
    console.log('PASS 8: two overlapping runs over the same due booking produced exactly 1 REMINDER and 1 outbox row (FR-75 backstop)')

    console.log('ALL SEND-REMINDERS ACCEPTANCE TESTS PASSED')
  } finally {
    // `email_outbox` is addressed, not linked: clear the rows addressed to the
    // fixture employee by address, or they leak into the shared dev database and
    // the dev server's cron will dutifully try to send them.
    if (employeeIds.length > 0) {
      const emails = employeeIds.map((id) => id)
      await manager.query(
        `DELETE FROM email_outbox WHERE to_email IN (SELECT email FROM employee WHERE id IN (${emails
          .map((_, i) => `$${i + 1}`)
          .join(',')}))`,
        employeeIds,
      )
    }
    if (bookingIds.length > 0) {
      const params = bookingIds.map((_, i) => `$${i + 1}`).join(',')
      await manager.query(`DELETE FROM booking_equipment WHERE booking_id IN (${params})`, bookingIds)
      await manager.query(`DELETE FROM notification WHERE booking_id IN (${params})`, bookingIds)
      await manager.query(`DELETE FROM audit_log WHERE booking_id IN (${params})`, bookingIds)
      await manager.query(`DELETE FROM booking WHERE id IN (${params})`, bookingIds)
    }
    if (roomIds.length > 0) {
      const params = roomIds.map((_, i) => `$${i + 1}`).join(',')
      await manager.query(`DELETE FROM meeting_room WHERE id IN (${params})`, roomIds)
    }
    if (employeeIds.length > 0) {
      const params = employeeIds.map((_, i) => `$${i + 1}`).join(',')
      await manager.query(`DELETE FROM user_role WHERE employee_id IN (${params})`, employeeIds)
      await manager.query(`DELETE FROM employee WHERE id IN (${params})`, employeeIds)
    }
    if (dataSource.isInitialized) await dataSource.destroy()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
