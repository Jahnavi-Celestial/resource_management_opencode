import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDataSource } from '../../../config/data-source'
import { InputValidationError } from '../../../common/errors/field-errors'
import { BookingService } from '../booking.service'
import { Booking } from '../booking.entity'
import { BookingEquipment } from '../booking-equipment.entity'
import { Employee } from '../../employee/employee.entity'
import { Equipment } from '../../equipment/equipment.entity'
import { MeetingRoom } from '../../room/room.entity'
import { loadEnv } from '../../../config/env'

let offsetCounter = 48
function nextOffset(): number {
  return offsetCounter++
}

async function main(): Promise<void> {
  const dataSource = createDataSource()
  await dataSource.initialize()
  dataSource.setOptions({ logging: false })

  const service = new BookingService(dataSource)
  const env = loadEnv()

  const employeeIds: string[] = []
  const roomIds: string[] = []
  const equipmentIds: string[] = []
  const bookingIds: string[] = []

  const BASE_TIME = new Date(Date.now() + 48 * 60 * 60 * 1000)
  function windowForOffset(offsetHours: number): { startTime: Date; endTime: Date } {
    const startTime = new Date(BASE_TIME.getTime() + offsetHours * 60 * 60 * 1000)
    return { startTime, endTime: new Date(startTime.getTime() + 60 * 60 * 1000) }
  }

  async function createEmployee(firstName: string, lastName: string, emailSuffix: string): Promise<string> {
    const repository = dataSource.getRepository(Employee)
    const employee = await repository.save(
      repository.create({
        firstName,
        lastName,
        email: `${emailSuffix}-${randomUUID()}@example.test`,
        password: 'fixture-password',
      }),
    )
    employeeIds.push(employee.id)
    return employee.id
  }

  async function createRoom(capacity: number): Promise<string> {
    const repository = dataSource.getRepository(MeetingRoom)
    const room = await repository.save(
      repository.create({
        name: `Approval fixture room ${randomUUID()}`,
        location: 'Test location',
        capacity,
        isActive: true,
      }),
    )
    roomIds.push(room.id)
    return room.id
  }

  async function createEquipment(quantityAvailable: number): Promise<string> {
    const repository = dataSource.getRepository(Equipment)
    const equipment = await repository.save(
      repository.create({
        name: `Approval fixture equipment ${randomUUID()}`,
        quantityAvailable,
        isActive: true,
      }),
    )
    equipmentIds.push(equipment.id)
    return equipment.id
  }

  async function createPendingBooking(employeeId: string, roomId: string, offsetHours?: number): Promise<Booking> {
    const repository = dataSource.getRepository(Booking)
    const oh = offsetHours ?? nextOffset()
    const win = windowForOffset(oh)
    const booking = await repository.save(
      repository.create({
        employeeId,
        roomId,
        startTime: win.startTime,
        endTime: win.endTime,
        purpose: 'Approval fixture booking',
        numberOfAttendees: 1,
        rejectionReason: null,
        status: 'PENDING',
      }),
    )
    bookingIds.push(booking.id)
    return booking
  }

  async function createPendingBookingWithEquipment(employeeId: string, roomId: string, equipmentId: string, offsetHours?: number): Promise<Booking> {
    const oh = offsetHours ?? nextOffset()
    const booking = await createPendingBooking(employeeId, roomId, oh)
    await dataSource.getRepository(BookingEquipment).save(
      dataSource.getRepository(BookingEquipment).create({
        bookingId: booking.id,
        equipmentId,
        quantity: 1,
      }),
    )
    return booking
  }

  async function getAudits(bookingId: string): Promise<Array<{ action: string; old_status: string | null; new_status: string; performed_by: string | null }>> {
    return (await dataSource.query(
      'SELECT action, old_status, new_status, performed_by FROM audit_log WHERE booking_id = $1 ORDER BY created_at ASC',
      [bookingId],
    )) as Array<{ action: string; old_status: string | null; new_status: string; performed_by: string | null }>
  }

  async function deleteByIds(sql: (placeholders: string) => string, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return
    }
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(',')
    await dataSource.query(sql(placeholders), ids)
  }

  async function cleanup(includeEmployees = false): Promise<void> {
    await deleteByIds((p) => `DELETE FROM booking_equipment WHERE booking_id IN (${p})`, bookingIds)
    await deleteByIds((p) => `DELETE FROM audit_log WHERE booking_id IN (${p})`, bookingIds)
    await deleteByIds((p) => `DELETE FROM booking WHERE id IN (${p})`, bookingIds)
    await deleteByIds((p) => `DELETE FROM meeting_room WHERE id IN (${p})`, roomIds)
    await deleteByIds((p) => `DELETE FROM equipment WHERE id IN (${p})`, equipmentIds)
    if (includeEmployees) {
      await deleteByIds((p) => `DELETE FROM employee WHERE id IN (${p})`, employeeIds)
    }
  }

  async function resetData(): Promise<void> {
    await cleanup()
    offsetCounter = 48
    roomIds.length = 0
    equipmentIds.length = 0
    bookingIds.length = 0
  }

  async function assertReject(label: string, operation: () => Promise<unknown>, message: RegExp): Promise<void> {
    let caught: unknown
    try {
      await operation()
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof Error, `${label}: expected an error`)
    assert.match((caught as Error).message, message)
    console.log(`PASS ${label}: ${(caught as Error).message}`)
  }

  try {
    // --- SCENARIO 1: Pending queue returns bookings in createdAt order ---
    await resetData()
    const ownerId = await createEmployee('Approval', 'Owner', 'owner')
    const managerId = await createEmployee('Approval', 'Manager', 'manager')
    const roomId = await createRoom(10)
    const inactiveRoomId = await createRoom(10)
    await dataSource.query(`UPDATE meeting_room SET is_active = false WHERE id = $1`, [inactiveRoomId])

    await createPendingBooking(ownerId, roomId, 48)
    await createPendingBooking(ownerId, roomId, 49)
    const queue = await service.pendingQueue({ page: 1, pageSize: 10 }, { field: 'createdAt', direction: 'ASC' })
    assert.equal(queue.items.length >= 2, true, 'Pending queue should return at least 2 PENDING bookings')
    assert.ok(queue.items[0]!.createdAt <= queue.items[1]!.createdAt, 'Queue ordered by createdAt ASC')
    console.log(`PASS 1 pending queue: ${queue.items.length} items, ordered by createdAt`)

    // --- SCENARIO 2: Approve a valid PENDING booking ---
    const toApprove = await createPendingBooking(ownerId, roomId, 50)
    const approved = await service.approveBooking(managerId, toApprove.id)
    assert.equal(approved.status, 'APPROVED', 'Booking should be APPROVED')
    const approveAudits = await getAudits(toApprove.id)
    assert.equal(approveAudits.length, 1, 'Should have exactly one audit row')
    assert.equal(approveAudits[0]!.action, 'APPROVE')
    assert.equal(approveAudits[0]!.old_status, 'PENDING')
    assert.equal(approveAudits[0]!.new_status, 'APPROVED')
    assert.equal(approveAudits[0]!.performed_by, managerId)
    console.log(`PASS 2 approve valid PENDING booking: ${toApprove.id} → APPROVED, audit correct`)

    // --- SCENARIO 3: Approve a non-PENDING booking ---
    const toApprove3 = await createPendingBooking(ownerId, roomId, 51)
    await service.approveBooking(managerId, toApprove3.id)
    await assertReject('3a approve already-APPROVED', () => service.approveBooking(managerId, toApprove3.id), /Cannot approve booking from status: APPROVED/)
    console.log('PASS 3a approve non-PENDING booking refused')

    // --- SCENARIO 4: Approve PENDING booking whose room was deactivated since submission ---
    const toApprove4 = await createPendingBooking(ownerId, inactiveRoomId, 52)
    await assertReject('4a approve inactive room', () => service.approveBooking(managerId, toApprove4.id), /The selected room is inactive/)
    assert.equal(
      (await dataSource.getRepository(Booking).findOneByOrFail({ id: toApprove4.id })).status,
      'PENDING',
      'Refused approval must leave the booking PENDING',
    )
    console.log('PASS 4a room deactivated → approve refused, booking stays PENDING')

    // --- SCENARIO 4b: Room capacity shrunk below the booked attendee count ---
    await dataSource.query(`UPDATE meeting_room SET capacity = 5 WHERE id = $1`, [roomId])
    const toApprove4b = await createPendingBooking(ownerId, roomId, 52)
    await dataSource.query(`UPDATE booking SET number_of_attendees = 6 WHERE id = $1`, [toApprove4b.id])
    await assertReject('4b approve over-capacity room', () => service.approveBooking(managerId, toApprove4b.id), /Room capacity exceeded: 6 attendees requested for a room with capacity 5/)
    assert.equal(
      (await dataSource.getRepository(Booking).findOneByOrFail({ id: toApprove4b.id })).status,
      'PENDING',
      'Refused approval must leave the booking PENDING',
    )
    console.log('PASS 4b room capacity shrunk → approve refused, booking stays PENDING')

    // --- SCENARIO 4c: Room booked elsewhere is impossible to stage: ex_booking_room_time_range blocks it ---
    await resetData()
    const room5 = await createRoom(10)
    const competingBooking5 = await createPendingBooking(ownerId, room5, 53)
    await service.approveBooking(managerId, competingBooking5.id)
    let overlapBlocked = false
    try {
      await createPendingBooking(ownerId, room5, 53)
    } catch (error) {
      overlapBlocked = (error as Error).message.includes('ex_booking_room_time_range')
    }
    assert.equal(overlapBlocked, true, 'DB exclusion constraint must block an overlapping PENDING booking')
    console.log('PASS 4c room booked elsewhere → blocked by ex_booking_room_time_range (FR-33 backstop)')

    // --- SCENARIO 4d: Approve PENDING booking whose equipment was taken by another approved booking ---
    await resetData()
    const holderRoomId = await createRoom(10)
    const claimantRoomId = await createRoom(10)
    const eqId = await createEquipment(1)
    const holderBooking = await createPendingBookingWithEquipment(ownerId, holderRoomId, eqId, 54)
    await service.approveBooking(managerId, holderBooking.id)
    const claimantBooking = await createPendingBookingWithEquipment(ownerId, claimantRoomId, eqId, 54)
    await assertReject('4d approve equipment already taken', () => service.approveBooking(managerId, claimantBooking.id), new RegExp(`Equipment ${eqId} is not available: requested 1, 0 free`))
    assert.equal(
      (await dataSource.getRepository(Booking).findOneByOrFail({ id: claimantBooking.id })).status,
      'PENDING',
      'Refused approval must leave the booking PENDING',
    )
    const claimantAudits = await getAudits(claimantBooking.id)
    assert.equal(claimantAudits.length, 0, 'Refused approval must not write an audit row')
    console.log('PASS 4d equipment taken by another booking → approve refused, no audit, stays PENDING')

    // --- SCENARIO 5: Reject with reason shorter than REJECTION_REASON_MIN_LENGTH ---
    await resetData()
    const rejectRoomId = await createRoom(10)
    const toReject5 = await createPendingBooking(ownerId, rejectRoomId, 55)
    const shortReason = 'too short'
    try {
      await service.rejectBooking(managerId, toReject5.id, shortReason)
      assert.fail('Should have thrown InputValidationError')
    } catch (error) {
      assert.ok(error instanceof InputValidationError, `Expected InputValidationError, got ${error?.constructor?.name}`)
      const felds = (error as InputValidationError).fieldErrors
      assert.ok(felds.some((f) => f.field === 'reason'), 'Should have field-level error for reason')
    }
    console.log(`PASS 5 reject with short reason (${shortReason.length} < ${env.rejectionReasonMinLength}) → InputValidationError`)

    // --- SCENARIO 6: Reject with valid reason ---
    const toReject6 = await createPendingBooking(ownerId, rejectRoomId, 56)
    const validReason = 'This booking is not needed' + 'x'.repeat(env.rejectionReasonMinLength)
    const rejected = await service.rejectBooking(managerId, toReject6.id, validReason)
    assert.equal(rejected.status, 'REJECTED', 'Booking should be REJECTED')
    assert.equal(rejected.rejectionReason, validReason, 'Rejection reason should be persisted')
    const rejectAudits = await getAudits(toReject6.id)
    assert.equal(rejectAudits.length, 1, 'Should have exactly one audit row')
    assert.equal(rejectAudits[0]!.action, 'REJECT')
    assert.equal(rejectAudits[0]!.old_status, 'PENDING')
    assert.equal(rejectAudits[0]!.new_status, 'REJECTED')
    assert.equal(rejectAudits[0]?.performed_by, managerId)
    console.log(`PASS 6 reject with valid reason: ${toReject6.id} → REJECTED, reason persisted, audit correct`)

    // --- SCENARIO 7: Rejected-then-rejected-again attempt ---
    await assertReject('7a reject already-REJECTED', () => service.rejectBooking(managerId, toReject6.id, validReason), /Cannot reject booking from status: REJECTED/)
    await assertReject('7b approve already-REJECTED', () => service.approveBooking(managerId, toReject6.id), /Cannot approve booking from status: REJECTED/)
    console.log('PASS 7 rejected booking cannot be rejected/approved again')

    console.log('ALL BOOKING APPROVAL ACCEPTANCE TESTS PASSED')
  } finally {
    await cleanup(true)
    if (dataSource.isInitialized) {
      await dataSource.destroy()
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
