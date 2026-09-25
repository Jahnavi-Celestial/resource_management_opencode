import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { DataSource } from 'typeorm'
import { createDataSource } from '../../../config/data-source'
import { DomainError } from '../../../common/errors/domain-error'
import { BookingService } from '../booking.service'
import { Booking } from '../booking.entity'
import { BookingEquipment } from '../booking-equipment.entity'
import { getEquipmentFreeQuantity, isRoomAvailable } from '../availability'
import { Employee } from '../../employee/employee.entity'
import { Equipment } from '../../equipment/equipment.entity'
import { MeetingRoom } from '../../room/room.entity'

type FixtureBooking = {
  id: string
  employeeId: string
  startTime: Date
  endTime: Date
  status: Booking['status']
}

type Fixture = {
  ownerId: string
  otherEmployeeId: string
  managerId: string
  roomId: string
  equipmentId: string
  bookings: FixtureBooking[]
}

type AuditRow = {
  action: string
  old_status: string | null
  new_status: string
  performed_by: string
}

type Counts = {
  booking: number
  bookingEquipment: number
  audit: number
  room: number
  employee: number
  equipment: number
}

function futureWindow(offsetHours: number, durationMinutes = 60): { startTime: Date; endTime: Date } {
  const startTime = new Date(Date.now() + offsetHours * 60 * 60 * 1000)
  return {
    startTime,
    endTime: new Date(startTime.getTime() + durationMinutes * 60 * 1000),
  }
}

function formatCounts(counts: Counts): string {
  return `booking=${counts.booking}, booking_equipment=${counts.bookingEquipment}, audit=${counts.audit}, room=${counts.room}, employee=${counts.employee}, equipment=${counts.equipment}`
}

async function createEmployee(dataSource: DataSource, firstName: string, lastName: string): Promise<string> {
  const repository = dataSource.getRepository(Employee)
  const employee = await repository.save(
    repository.create({
      firstName,
      lastName,
      email: `booking-cancel-${randomUUID()}@example.test`,
      password: 'fixture-password',
    }),
  )
  return employee.id
}

async function createRoom(dataSource: DataSource): Promise<string> {
  const repository = dataSource.getRepository(MeetingRoom)
  const room = await repository.save(
    repository.create({
      name: `Booking cancellation room ${randomUUID()}`,
      location: 'Cancellation test location',
      capacity: 10,
      isActive: true,
    }),
  )
  return room.id
}

async function createEquipment(dataSource: DataSource): Promise<string> {
  const repository = dataSource.getRepository(Equipment)
  const equipment = await repository.save(
    repository.create({
      name: `Booking cancellation equipment ${randomUUID()}`,
      quantityAvailable: 2,
      isActive: true,
    }),
  )
  return equipment.id
}

async function createBooking(
  dataSource: DataSource,
  employeeId: string,
  roomId: string,
  window: { startTime: Date; endTime: Date },
  status: Booking['status'],
): Promise<FixtureBooking> {
  const repository = dataSource.getRepository(Booking)
  const booking = await repository.save(
    repository.create({
      employeeId,
      roomId,
      startTime: window.startTime,
      endTime: window.endTime,
      purpose: 'Booking cancellation acceptance fixture',
      numberOfAttendees: 1,
      rejectionReason: null,
      status,
    }),
  )
  return {
    id: booking.id,
    employeeId,
    startTime: window.startTime,
    endTime: window.endTime,
    status,
  }
}

async function addEquipment(dataSource: DataSource, bookingId: string, equipmentId: string, quantity: number): Promise<void> {
  const repository = dataSource.getRepository(BookingEquipment)
  await repository.save(
    repository.create({
      bookingId,
      equipmentId,
      quantity,
    }),
  )
}

async function getBooking(dataSource: DataSource, bookingId: string): Promise<Booking> {
  const booking = await dataSource.getRepository(Booking).findOneBy({ id: bookingId })
  if (booking === null) {
    throw new Error(`Booking fixture ${bookingId} is missing`)
  }
  return booking
}

async function getAudits(dataSource: DataSource, bookingId: string): Promise<AuditRow[]> {
  return (await dataSource.query(
    'SELECT action, old_status, new_status, performed_by FROM audit_log WHERE booking_id = $1 ORDER BY created_at ASC',
    [bookingId],
  )) as AuditRow[]
}

async function assertNoAudit(dataSource: DataSource, bookingId: string, label: string): Promise<void> {
  const audits = await getAudits(dataSource, bookingId)
  assert.equal(audits.length, 0, `${label}: expected no audit row`)
}

async function assertCancelAudit(
  dataSource: DataSource,
  bookingId: string,
  oldStatus: string,
  newStatus: string,
  performedBy: string,
): Promise<AuditRow> {
  const audits = await getAudits(dataSource, bookingId)
  assert.equal(audits.length, 1, `expected one CANCEL audit row for ${bookingId}`)
  const audit = audits[0]
  assert.ok(audit)
  assert.equal(audit.action, 'CANCEL')
  assert.equal(audit.old_status, oldStatus)
  assert.equal(audit.new_status, newStatus)
  assert.equal(audit.performed_by, performedBy)
  return audit
}

async function assertRejected(
  label: string,
  operation: () => Promise<unknown>,
  message: RegExp,
): Promise<void> {
  let caught: unknown
  try {
    await operation()
  } catch (error) {
    caught = error
  }

  assert.ok(caught instanceof DomainError, `${label}: expected a DomainError`)
  assert.match(caught.message, message)
  console.log(`PASS ${label}: ${caught.message}`)
}

async function cleanup(dataSource: DataSource, fixture: Fixture): Promise<void> {
  const bookingIds = fixture.bookings.map((booking) => booking.id)
  if (bookingIds.length > 0) {
    await dataSource.query('DELETE FROM booking_equipment WHERE booking_id = ANY($1::uuid[])', [bookingIds])
    await dataSource.query('DELETE FROM audit_log WHERE booking_id = ANY($1::uuid[])', [bookingIds])
    await dataSource.query('DELETE FROM booking WHERE id = ANY($1::uuid[])', [bookingIds])
  }
  await dataSource.query('DELETE FROM equipment WHERE id = $1', [fixture.equipmentId])
  await dataSource.query('DELETE FROM meeting_room WHERE id = $1', [fixture.roomId])
  await dataSource.query('DELETE FROM employee WHERE id = ANY($1::uuid[])', [
    [fixture.ownerId, fixture.otherEmployeeId, fixture.managerId],
  ])
}

async function readCounts(dataSource: DataSource, fixture: Fixture): Promise<Counts> {
  const bookingIds = fixture.bookings.map((booking) => booking.id)
  const [row] = await dataSource.query(
    `
      SELECT
        (SELECT COUNT(*)::int FROM booking WHERE id = ANY($1::uuid[])) AS booking,
        (SELECT COUNT(*)::int
           FROM booking_equipment
           WHERE booking_id = ANY($1::uuid[])) AS booking_equipment,
        (SELECT COUNT(*)::int
           FROM audit_log
           WHERE booking_id = ANY($1::uuid[])) AS audit,
        (SELECT COUNT(*)::int FROM meeting_room WHERE id = $2) AS room,
        (SELECT COUNT(*)::int FROM employee WHERE id = ANY($3::uuid[])) AS employee,
        (SELECT COUNT(*)::int FROM equipment WHERE id = $4) AS equipment
    `,
    [bookingIds, fixture.roomId, [fixture.ownerId, fixture.otherEmployeeId, fixture.managerId], fixture.equipmentId],
  )

  return {
    booking: Number(row.booking),
    bookingEquipment: Number(row.booking_equipment),
    audit: Number(row.audit),
    room: Number(row.room),
    employee: Number(row.employee),
    equipment: Number(row.equipment),
  }
}

async function main(): Promise<void> {
  const dataSource = createDataSource()
  await dataSource.initialize()
  dataSource.setOptions({ logging: false })

  const fixture: Fixture = {
    ownerId: '',
    otherEmployeeId: '',
    managerId: '',
    roomId: '',
    equipmentId: '',
    bookings: [],
  }
  const service = new BookingService(dataSource)

  try {
    fixture.ownerId = await createEmployee(dataSource, 'Cancellation', 'Owner')
    fixture.otherEmployeeId = await createEmployee(dataSource, 'Cancellation', 'Other')
    fixture.managerId = await createEmployee(dataSource, 'Cancellation', 'Manager')
    fixture.roomId = await createRoom(dataSource)
    fixture.equipmentId = await createEquipment(dataSource)

    fixture.bookings = [
      await createBooking(dataSource, fixture.ownerId, fixture.roomId, futureWindow(48), 'PENDING'),
      await createBooking(dataSource, fixture.otherEmployeeId, fixture.roomId, futureWindow(52), 'PENDING'),
      await createBooking(dataSource, fixture.ownerId, fixture.roomId, futureWindow(56), 'APPROVED'),
      await createBooking(dataSource, fixture.otherEmployeeId, fixture.roomId, futureWindow(60), 'APPROVED'),
      await createBooking(dataSource, fixture.otherEmployeeId, fixture.roomId, futureWindow(64), 'COMPLETED'),
      await createBooking(dataSource, fixture.otherEmployeeId, fixture.roomId, futureWindow(68), 'CANCELLED'),
    ]
    await addEquipment(dataSource, fixture.bookings[0]!.id, fixture.equipmentId, 1)

    const ownerPending = fixture.bookings[0]!
    const otherPending = fixture.bookings[1]!
    const ownerApproved = fixture.bookings[2]!
    const otherApproved = fixture.bookings[3]!
    const otherCompleted = fixture.bookings[4]!
    const otherCancelled = fixture.bookings[5]!

    const roomAvailableBefore = await isRoomAvailable(
      dataSource.manager,
      fixture.roomId,
      ownerPending.startTime,
      ownerPending.endTime,
    )
    const equipmentFreeBefore = await getEquipmentFreeQuantity(
      dataSource.manager,
      fixture.equipmentId,
      ownerPending.startTime,
      ownerPending.endTime,
    )
    assert.equal(roomAvailableBefore, false, 'room should be occupied before cancellation')
    assert.equal(equipmentFreeBefore, 1, 'equipment should have one committed unit before cancellation')

    const ownerResult = await service.cancelOwnBooking(fixture.ownerId, ownerPending.id)
    assert.equal(ownerResult.status, 'CANCELLED')
    assert.equal((await getBooking(dataSource, ownerPending.id)).status, 'CANCELLED')
    const ownerAudit = await assertCancelAudit(dataSource, ownerPending.id, 'PENDING', 'CANCELLED', fixture.ownerId)
    console.log(`PASS 1 owner cancels own PENDING booking: status=CANCELLED, audit=${ownerAudit.action} ${ownerAudit.old_status}->${ownerAudit.new_status}`)

    await assertRejected(
      '2 owner cancels another employee booking',
      () => service.cancelOwnBooking(fixture.ownerId, otherPending.id),
      /requester/i,
    )
    assert.equal((await getBooking(dataSource, otherPending.id)).status, 'PENDING')
    await assertNoAudit(dataSource, otherPending.id, '2 ownership rejection')

    await assertRejected(
      '3 owner cancels own APPROVED booking',
      () => service.cancelOwnBooking(fixture.ownerId, ownerApproved.id),
      /current status: APPROVED/i,
    )
    assert.equal((await getBooking(dataSource, ownerApproved.id)).status, 'APPROVED')
    await assertNoAudit(dataSource, ownerApproved.id, '3 self-cancel status rejection')

    const managerPendingResult = await service.cancelAnyBooking(fixture.managerId, otherPending.id)
    assert.equal(managerPendingResult.status, 'CANCELLED')
    assert.equal((await getBooking(dataSource, otherPending.id)).status, 'CANCELLED')
    const managerPendingAudit = await assertCancelAudit(
      dataSource,
      otherPending.id,
      'PENDING',
      'CANCELLED',
      fixture.managerId,
    )
    console.log(`PASS 4 manager cancels another employee PENDING booking: status=CANCELLED, audit=${managerPendingAudit.action} ${managerPendingAudit.old_status}->${managerPendingAudit.new_status}`)

    const managerApprovedResult = await service.cancelAnyBooking(fixture.managerId, otherApproved.id)
    assert.equal(managerApprovedResult.status, 'CANCELLED')
    assert.equal((await getBooking(dataSource, otherApproved.id)).status, 'CANCELLED')
    const managerApprovedAudit = await assertCancelAudit(
      dataSource,
      otherApproved.id,
      'APPROVED',
      'CANCELLED',
      fixture.managerId,
    )
    console.log(`PASS 5 manager cancels another employee APPROVED booking: status=CANCELLED, audit=${managerApprovedAudit.action} ${managerApprovedAudit.old_status}->${managerApprovedAudit.new_status}`)

    await assertRejected(
      '6a manager cancels already-CANCELLED booking',
      () => service.cancelAnyBooking(fixture.managerId, otherCancelled.id),
      /current status: CANCELLED/i,
    )
    assert.equal((await getBooking(dataSource, otherCancelled.id)).status, 'CANCELLED')
    await assertNoAudit(dataSource, otherCancelled.id, '6a already-CANCELLED rejection')

    await assertRejected(
      '6b manager cancels COMPLETED booking',
      () => service.cancelAnyBooking(fixture.managerId, otherCompleted.id),
      /current status: COMPLETED/i,
    )
    assert.equal((await getBooking(dataSource, otherCompleted.id)).status, 'COMPLETED')
    await assertNoAudit(dataSource, otherCompleted.id, '6b COMPLETED rejection')

    const roomAvailableAfter = await isRoomAvailable(
      dataSource.manager,
      fixture.roomId,
      ownerPending.startTime,
      ownerPending.endTime,
    )
    const equipmentFreeAfter = await getEquipmentFreeQuantity(
      dataSource.manager,
      fixture.equipmentId,
      ownerPending.startTime,
      ownerPending.endTime,
    )
    assert.equal(roomAvailableAfter, true, 'room should be available immediately after cancellation')
    assert.equal(equipmentFreeAfter, 2, 'equipment should be fully available immediately after cancellation')
    console.log(`PASS 7 availability after cancellation: roomAvailable=${roomAvailableAfter}, equipmentFree=${equipmentFreeAfter}`)

    console.log('ALL BOOKING CANCELLATION ACCEPTANCE TESTS PASSED')
  } finally {
    try {
      await cleanup(dataSource, fixture)
      const counts = await readCounts(dataSource, fixture)
      console.log(`CANCEL CLEANUP row_counts: ${formatCounts(counts)}`)
      assert.equal(counts.booking, 0, 'cleanup left booking rows')
      assert.equal(counts.bookingEquipment, 0, 'cleanup left booking_equipment rows')
      assert.equal(counts.audit, 0, 'cleanup left audit rows')
      assert.equal(counts.room, 0, 'cleanup left meeting room rows')
      assert.equal(counts.employee, 0, 'cleanup left employee rows')
      assert.equal(counts.equipment, 0, 'cleanup left equipment rows')
    } finally {
      if (dataSource.isInitialized) {
        await dataSource.destroy()
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
