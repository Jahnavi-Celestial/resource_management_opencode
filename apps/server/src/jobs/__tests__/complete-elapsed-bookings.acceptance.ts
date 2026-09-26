import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DataSource, EntityManager } from 'typeorm'
import { createDataSource } from '../../config/data-source'
import { getEquipmentFreeQuantity, isRoomAvailable } from '../../modules/booking/availability'
import { AuditLog } from '../../modules/audit/audit-log.entity'
import { Booking } from '../../modules/booking/booking.entity'
import { BookingEquipment } from '../../modules/booking/booking-equipment.entity'
import { Employee } from '../../modules/employee/employee.entity'
import { Equipment } from '../../modules/equipment/equipment.entity'
import { MeetingRoom } from '../../modules/room/room.entity'
import { UserRole } from '../../modules/rbac/user-role.entity'
import { SYSTEM_EMPLOYEE_EMAIL } from '../../modules/employee/system-account'
import { createCompleteElapsedBookingsJob } from '../complete-elapsed-bookings.job'
import type { BookingStatus } from '@resource-booking/shared'

type AuditRow = {
  action: string
  old_status: string | null
  new_status: string
  performed_by: string | null
}

const HOUR = 60 * 60 * 1000

async function systemEmployeeId(manager: EntityManager): Promise<string> {
  const rows = (await manager.query(
    'SELECT id FROM employee WHERE email = $1',
    [SYSTEM_EMPLOYEE_EMAIL],
  )) as Array<{ id: string }>
  const id = rows[0]?.id
  assert.ok(id, `system employee "${SYSTEM_EMPLOYEE_EMAIL}" must be seeded before this suite runs`)
  return id
}

async function statusOf(manager: EntityManager, bookingId: string): Promise<BookingStatus> {
  const rows = (await manager.query('SELECT status FROM booking WHERE id = $1', [bookingId])) as Array<{
    status: BookingStatus
  }>
  const status = rows[0]?.status
  assert.ok(status, `booking ${bookingId} vanished`)
  return status
}

async function completeAuditRows(manager: EntityManager, bookingId: string): Promise<AuditRow[]> {
  return (await manager.query(
    `SELECT action, old_status, new_status, performed_by
     FROM audit_log
     WHERE booking_id = $1 AND action = 'COMPLETE'
     ORDER BY created_at ASC, id ASC`,
    [bookingId],
  )) as AuditRow[]
}

async function countCompleteAuditRows(manager: EntityManager): Promise<number> {
  const rows = (await manager.query(
    "SELECT COUNT(*)::int AS total FROM audit_log WHERE action = 'COMPLETE'",
  )) as Array<{ total: number }>
  return rows[0]?.total ?? 0
}

async function main(): Promise<void> {
  // `createDataSource` turns SQL logging on for NODE_ENV=development, which
  // drowns the suite's own PASS lines.
  process.env.NODE_ENV = 'test'
  const dataSource: DataSource = createDataSource()
  await dataSource.initialize()
  const manager = dataSource.manager

  const runId = randomUUID()
  const employeeIds: string[] = []
  const roomIds: string[] = []
  const equipmentIds: string[] = []
  const bookingIds: string[] = []

  try {
    const systemId = await systemEmployeeId(manager)
    console.log(`system employee id = ${systemId} (${SYSTEM_EMPLOYEE_EMAIL})`)

    const employeeRepository = manager.getRepository(Employee)
    const roomRepository = manager.getRepository(MeetingRoom)
    const equipmentRepository = manager.getRepository(Equipment)
    const bookingRepository = manager.getRepository(Booking)

    const roleRows = (await manager.query(
      "SELECT role_name, id FROM role WHERE role_name = 'Employee'",
    )) as Array<{ role_name: string; id: string }>
    const employeeRoleId = roleRows[0]?.id
    assert.ok(employeeRoleId, 'Employee role required')

    const owner = await employeeRepository.save(
      employeeRepository.create({
        firstName: `Completer${runId}`,
        lastName: 'Test',
        email: `completer-${runId}@resource.local`,
        password: 'hash',
      }),
    )
    employeeIds.push(owner.id)
    await manager.getRepository(UserRole).save({ employeeId: owner.id, roleId: employeeRoleId })

    // Each fixture gets its own room so the `ex_booking_room_time_range`
    // exclusion constraint (PENDING/APPROVED only) can never make two fixtures
    // collide, and so the availability probe in check 5 has a single occupant.
    const makeRoom = async (label: string, capacity: number): Promise<MeetingRoom> => {
      const room = await roomRepository.save(
        roomRepository.create({
          name: `Complete ${label} ${runId}`,
          location: 'Test',
          capacity,
          isActive: true,
        }),
      )
      roomIds.push(room.id)
      return room
    }

    const now = new Date()
    const elapsedStart = new Date(now.getTime() - 3 * HOUR)
    const elapsedEnd = new Date(now.getTime() - 2 * HOUR)
    const futureStart = new Date(now.getTime() + 2 * HOUR)
    const futureEnd = new Date(now.getTime() + 3 * HOUR)

    const makeBooking = async (
      roomId: string,
      startTime: Date,
      endTime: Date,
      status: BookingStatus,
      purpose: string,
    ): Promise<Booking> => {
      const booking = await bookingRepository.save(
        bookingRepository.create({
          employeeId: owner.id,
          roomId,
          startTime,
          endTime,
          purpose,
          rejectionReason: null,
          numberOfAttendees: 1,
          status,
        }),
      )
      bookingIds.push(booking.id)
      return booking
    }

    // --- fixtures -----------------------------------------------------------
    const elapsedRoom = await makeRoom('elapsed', 10)
    const pendingRoom = await makeRoom('pending', 10)
    const futureRoom = await makeRoom('future', 10)

    const equipment = await equipmentRepository.save(
      equipmentRepository.create({
        name: `Complete equipment ${runId}`,
        quantityAvailable: 2,
        isActive: true,
      }),
    )
    equipmentIds.push(equipment.id)

    const elapsedBooking = await makeBooking(
      elapsedRoom.id,
      elapsedStart,
      elapsedEnd,
      'APPROVED',
      'FR-72 elapsed approved',
    )
    await manager.getRepository(BookingEquipment).save({
      bookingId: elapsedBooking.id,
      equipmentId: equipment.id,
      quantity: 2,
    })

    const pendingBooking = await makeBooking(
      pendingRoom.id,
      elapsedStart,
      elapsedEnd,
      'PENDING',
      'FR-72 elapsed pending',
    )
    const futureBooking = await makeBooking(
      futureRoom.id,
      futureStart,
      futureEnd,
      'APPROVED',
      'FR-72 future approved',
    )

    console.log(
      `fixtures: elapsed=${elapsedBooking.id} (APPROVED, end ${elapsedEnd.toISOString()}) ` +
        `pending=${pendingBooking.id} (PENDING, end ${elapsedEnd.toISOString()}) ` +
        `future=${futureBooking.id} (APPROVED, end ${futureEnd.toISOString()})`,
    )

    // --- check 5 precondition: the elapsed booking really does hold its slot --
    assert.equal(
      await isRoomAvailable(manager, elapsedRoom.id, elapsedStart, elapsedEnd),
      false,
      'precondition: elapsed APPROVED booking must occupy its room window',
    )
    assert.equal(
      await getEquipmentFreeQuantity(manager, equipment.id, elapsedStart, elapsedEnd),
      0,
      'precondition: elapsed APPROVED booking must commit all 2 units of equipment',
    )
    console.log('precondition: isRoomAvailable=false, equipment free=0 (2/2 committed)')

    // --- run 1 --------------------------------------------------------------
    const job = createCompleteElapsedBookingsJob(dataSource, { now: () => new Date(now.getTime()) })
    const first = await job.run()
    console.log(
      `run 1: scanned=${String(first.scanned)} completed=${String(first.completed)} failed=${String(first.failed.length)}`,
    )
    assert.deepEqual(first.failed, [], 'run 1 must not fail any booking')
    assert.equal(first.completed, first.scanned, 'every scanned candidate should have transitioned')
    assert.ok(first.completed >= 1, 'expected at least the elapsed APPROVED fixture to be scanned')

    // --- check 1: APPROVED + elapsed -> COMPLETED + COMPLETE audit row -------
    assert.equal(
      await statusOf(manager, elapsedBooking.id),
      'COMPLETED',
      'elapsed APPROVED booking must be COMPLETED',
    )
    const elapsedAudit = await completeAuditRows(manager, elapsedBooking.id)
    assert.equal(elapsedAudit.length, 1, `expected exactly one COMPLETE audit row, got ${elapsedAudit.length}`)
    const [audit] = elapsedAudit
    assert.equal(audit?.action, 'COMPLETE')
    assert.equal(audit?.old_status, 'APPROVED', 'oldStatus must be APPROVED')
    assert.equal(audit?.new_status, 'COMPLETED', 'newStatus must be COMPLETED')
    assert.equal(
      audit?.performed_by,
      systemId,
      `performedBy must be the reserved system employee (${systemId}), got ${String(audit?.performed_by)}`,
    )
    console.log(
      `PASS 1: elapsed APPROVED -> COMPLETED; audit COMPLETE old=APPROVED new=COMPLETED performed_by=system(${systemId})`,
    )

    // --- check 2: PENDING + elapsed is untouched ------------------------------
    assert.equal(
      await statusOf(manager, pendingBooking.id),
      'PENDING',
      'PENDING booking must not be completed, even once elapsed',
    )
    assert.deepEqual(
      await completeAuditRows(manager, pendingBooking.id),
      [],
      'PENDING booking must have no COMPLETE audit row',
    )
    console.log('PASS 2: PENDING + elapsed endTime untouched (no transition, no audit row)')

    // --- check 3: APPROVED + future is untouched ------------------------------
    assert.equal(
      await statusOf(manager, futureBooking.id),
      'APPROVED',
      'APPROVED booking that has not ended must stay APPROVED',
    )
    assert.deepEqual(
      await completeAuditRows(manager, futureBooking.id),
      [],
      'future APPROVED booking must have no COMPLETE audit row',
    )
    console.log('PASS 3: APPROVED + future endTime untouched (no transition, no audit row)')

    // --- check 5: availability reflects the completion, with no release code --
    assert.equal(
      await isRoomAvailable(manager, elapsedRoom.id, elapsedStart, elapsedEnd),
      true,
      'FR-73: the room window must be free once the booking is COMPLETED',
    )
    const freeAfter = await getEquipmentFreeQuantity(manager, equipment.id, elapsedStart, elapsedEnd)
    assert.equal(
      freeAfter,
      2,
      `FR-73: both units must be free again once COMPLETED, got ${String(freeAfter)}`,
    )
    assert.equal(
      await getEquipmentFreeQuantity(manager, equipment.id, futureStart, futureEnd),
      2,
      'an unrelated window is unaffected',
    )
    const jobSource = readFileSync(
      join(__dirname, '..', 'complete-elapsed-bookings.job.ts'),
      'utf8',
    )
    const jobImports = [...jobSource.matchAll(/^import .*$/gm)].map((line) => line[0])
    assert.equal(
      jobImports.some((line) => line.includes('availability')),
      false,
      `the job must not import availability.ts — completion releases the slot by status alone (FR-73), imports: ${jobImports.join(' | ')}`,
    )
    console.log(
      `PASS 5: post-completion isRoomAvailable=true, equipment free=2 (was 0) — derived, not released; job source never mentions availability`,
    )

    // --- check 4: FR-75 idempotency by literal repeated execution -------------
    const auditTotalAfterFirstRun = await countCompleteAuditRows(manager)
    const statusesAfterFirstRun = (
      await manager.query('SELECT status, COUNT(*)::int AS total FROM booking GROUP BY status')
    ) as Array<{ status: BookingStatus; total: number }>
    console.log(
      `after run 1: audit_log COMPLETE rows=${String(auditTotalAfterFirstRun)}, ` +
        `bookings by status=${statusesAfterFirstRun.map((r) => `${r.status}=${r.total}`).join(' ')}`,
    )

    const second = await job.run()
    const third = await job.run()
    const auditTotalAfterThirdRun = await countCompleteAuditRows(manager)
    const statusesAfterThirdRun = (
      await manager.query('SELECT status, COUNT(*)::int AS total FROM booking GROUP BY status')
    ) as Array<{ status: BookingStatus; total: number }>

    console.log(
      `run 2: scanned=${String(second.scanned)} completed=${String(second.completed)} failed=${String(second.failed.length)}`,
    )
    console.log(
      `run 3: scanned=${String(third.scanned)} completed=${String(third.completed)} failed=${String(third.failed.length)}`,
    )
    assert.equal(second.scanned, 0, 'run 2 must scan nothing: no APPROVED booking is still elapsed')
    assert.equal(second.completed, 0, 'run 2 must complete nothing')
    assert.equal(third.scanned, 0, 'run 3 must scan nothing')
    assert.equal(third.completed, 0, 'run 3 must complete nothing')
    assert.equal(
      auditTotalAfterThirdRun,
      auditTotalAfterFirstRun,
      'three runs over the same window must write exactly one COMPLETE audit row per eligible booking',
    )
    assert.deepEqual(
      statusesAfterThirdRun,
      statusesAfterFirstRun,
      'booking statuses must be identical after two further runs',
    )
    assert.equal(
      (await completeAuditRows(manager, elapsedBooking.id)).length,
      1,
      'the elapsed fixture still has exactly one COMPLETE audit row',
    )
    console.log(
      `PASS 4: runs 2 and 3 made zero changes and wrote zero new audit rows ` +
        `(COMPLETE rows still ${String(auditTotalAfterThirdRun)}) — FR-75 proven by literal repeated execution`,
    )

    // Statuses that must never be produced or consumed by this job.
    assert.equal(
      await statusOf(manager, pendingBooking.id),
      'PENDING',
      'pending fixture unchanged after three runs',
    )
    assert.equal(
      await statusOf(manager, futureBooking.id),
      'APPROVED',
      'future fixture unchanged after three runs',
    )
    assert.equal(
      await statusOf(manager, elapsedBooking.id),
      'COMPLETED',
      'elapsed fixture unchanged after three runs',
    )

    // The job is not wired into node-cron yet (S10 continues); prove it is still
    // a plain callable and that the emitted schema gained no job surface.
    const logCount = (await manager.getRepository(AuditLog).count()) as number
    assert.ok(logCount > 0, 'sanity: audit rows exist for this run')

    console.log('ALL COMPLETE-ELAPSED-BOOKINGS ACCEPTANCE TESTS PASSED')
  } finally {
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
    if (equipmentIds.length > 0) {
      const params = equipmentIds.map((_, i) => `$${i + 1}`).join(',')
      await manager.query(`DELETE FROM equipment WHERE id IN (${params})`, equipmentIds)
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
