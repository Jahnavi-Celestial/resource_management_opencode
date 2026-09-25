import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import * as dataSourceModule from '../../../config/data-source'
import { BookingService } from '../booking.service'
import type { CreateBookingInput } from '../booking.inputs'
import { Employee } from '../../employee/employee.entity'
import { MeetingRoom } from '../../room/room.entity'
import { Equipment } from '../../equipment/equipment.entity'
import { InputValidationError } from '../../../common/errors/field-errors'

async function main(): Promise<void> {
  const configuredDataSource = await dataSourceModule.createDataSource()

  if (!(configuredDataSource instanceof DataSource)) {
    throw new Error('No DataSource export found in config/data-source')
  }

  const dataSource: DataSource = configuredDataSource
  if (!dataSource.isInitialized) {
    await dataSource.initialize()
  }
  dataSource.setOptions({ logging: false })

  const service = new BookingService(dataSource)
  const employeeIds: string[] = []
  const roomIds: string[] = []
  const equipmentIds: string[] = []

  function futureWindow(offsetHours: number, durationMinutes = 60): { startTime: Date; endTime: Date } {
    const startTime = new Date(Date.now() + offsetHours * 60 * 60 * 1000)
    return {
      startTime,
      endTime: new Date(startTime.getTime() + durationMinutes * 60 * 1000),
    }
  }

  async function createEmployee(): Promise<string> {
    const repository = dataSource.getRepository(Employee)
    const employee = await repository.save(
      repository.create({
        firstName: 'Booking',
        lastName: 'Fixture',
        email: `booking-${randomUUID()}@example.test`,
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
        name: `Booking fixture room ${randomUUID()}`,
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
        name: `Booking fixture equipment ${randomUUID()}`,
        quantityAvailable,
        isActive: true,
      }),
    )
    equipmentIds.push(equipment.id)
    return equipment.id
  }

  function baseInput(
    roomId: string,
    window: { startTime: Date; endTime: Date },
    overrides: Partial<CreateBookingInput> = {},
  ): CreateBookingInput {
    return {
      roomId,
      startTime: window.startTime,
      endTime: window.endTime,
      purpose: 'Booking acceptance fixture',
      numberOfAttendees: 1,
      ...overrides,
    }
  }

  async function count(table: 'booking' | 'booking_equipment' | 'audit_log'): Promise<number> {
    const rows = await dataSource.query(`SELECT COUNT(*)::int AS count FROM ${table}`)
    return Number(rows[0].count)
  }

  async function assertFailure(
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

    assert.ok(caught instanceof Error, `${label}: expected a domain error`)
    const errorText = caught instanceof InputValidationError
      ? `${caught.message}: ${caught.fieldErrors.map((fieldError) => `${fieldError.field} ${fieldError.message}`).join('; ')}`
      : caught.message
    assert.match(errorText, message)
    console.log(`PASS ${label}: ${errorText}`)
  }

  async function assertBookingWithoutRows(label: string, before: [number, number, number]): Promise<void> {
    const after: [number, number, number] = [
      await count('booking'),
      await count('booking_equipment'),
      await count('audit_log'),
    ]
    assert.deepEqual(after, before, `${label}: validation failure changed row counts`)
    console.log(`PASS ${label}: booking/booking_equipment/audit_log counts unchanged (${after.join('/')})`)
  }

  async function cleanup(): Promise<void> {
    if (roomIds.length === 0 && equipmentIds.length === 0 && employeeIds.length === 0) {
      return
    }

    const roomParams = roomIds.map((_, index) => `$${index + 1}`).join(',')
    if (roomIds.length > 0) {
      await dataSource.query(
        `DELETE FROM booking_equipment WHERE booking_id IN (SELECT id FROM booking WHERE room_id IN (${roomParams}))`,
        roomIds,
      )
      await dataSource.query(
        `DELETE FROM audit_log WHERE booking_id IN (SELECT id FROM booking WHERE room_id IN (${roomParams}))`,
        roomIds,
      )
      await dataSource.query(`DELETE FROM booking WHERE room_id IN (${roomParams})`, roomIds)
      await dataSource.query(`DELETE FROM meeting_room WHERE id IN (${roomParams})`, roomIds)
    }

    const equipmentParams = equipmentIds.map((_, index) => `$${index + 1}`).join(',')
    if (equipmentIds.length > 0) {
      await dataSource.query(`DELETE FROM equipment WHERE id IN (${equipmentParams})`, equipmentIds)
    }

    const employeeParams = employeeIds.map((_, index) => `$${index + 1}`).join(',')
    if (employeeIds.length > 0) {
      await dataSource.query(`DELETE FROM employee WHERE id IN (${employeeParams})`, employeeIds)
    }
  }

  try {
    const employeeId = await createEmployee()
    const roomId = await createRoom(4)
    const capacityRoomId = await createRoom(2)
    const overlapRoomId = await createRoom(4)
    const equipmentRoomId = await createRoom(4)
    const equipmentRoomId2 = await createRoom(4)
    const roomOnlyWindow = futureWindow(48)
    const pastWindow = futureWindow(-2)
    const intervalWindow = futureWindow(50)

    await assertFailure(
      '1 missing room',
      () => {
        const { roomId: _roomId, ...withoutRoom } = baseInput(roomId, roomOnlyWindow)
        return service.createBooking(employeeId, withoutRoom as CreateBookingInput)
      },
      /roomId/,
    )

    await assertFailure(
      '2 end time before start time',
      () =>
        service.createBooking(
          employeeId,
          baseInput(roomId, {
            startTime: intervalWindow.startTime,
            endTime: new Date(intervalWindow.startTime.getTime() - 1),
          }),
        ),
      /end time.*strictly after start time/i,
    )

    await assertFailure(
      '3 start time in the past',
      () => service.createBooking(employeeId, baseInput(roomId, pastWindow)),
      /start time.*past/i,
    )

    await assertFailure(
      '4 attendees exceeding room capacity',
      () => service.createBooking(employeeId, baseInput(capacityRoomId, futureWindow(52), { numberOfAttendees: 3 })),
      /room capacity exceeded/i,
    )

    const overlapWindow = futureWindow(56)
    const overlapSeed = await service.createBooking(
      employeeId,
      baseInput(overlapRoomId, overlapWindow),
    )
    await assertFailure(
      '5 overlapping room booking',
      () =>
        service.createBooking(
          employeeId,
          baseInput(overlapRoomId, {
            startTime: new Date(overlapWindow.startTime.getTime() + 30 * 60 * 1000),
            endTime: new Date(overlapWindow.endTime.getTime() + 30 * 60 * 1000),
          }),
        ),
      /room is not available/i,
    )
    assert.equal(overlapSeed.status, 'PENDING')

    const equipmentId = await createEquipment(2)
    const equipmentWindow = futureWindow(60)
    await service.createBooking(
      employeeId,
      baseInput(equipmentRoomId, equipmentWindow, { equipment: [{ equipmentId, quantity: 2 }] }),
    )
    await assertFailure(
      '6 equipment quantity exceeding availability',
      () =>
        service.createBooking(
          employeeId,
          baseInput(equipmentRoomId2, equipmentWindow, { equipment: [{ equipmentId, quantity: 3 }] }),
        ),
      /equipment .*not available/i,
    )

    const zeroEquipmentId = await createEquipment(5)
    await assertFailure(
      '7 zero equipment quantity',
      () =>
        service.createBooking(
          employeeId,
          baseInput(roomId, futureWindow(64), { equipment: [{ equipmentId: zeroEquipmentId, quantity: 0 }] }),
        ),
      /quantity/i,
    )
    await assertFailure(
      '7 negative equipment quantity',
      () =>
        service.createBooking(
          employeeId,
          baseInput(roomId, futureWindow(65), { equipment: [{ equipmentId: zeroEquipmentId, quantity: -1 }] }),
        ),
      /quantity/i,
    )

    const roomOnlyBooking = await service.createBooking(employeeId, baseInput(roomId, roomOnlyWindow))
    assert.equal(roomOnlyBooking.status, 'PENDING')
    const roomOnlyLines = await dataSource.query(
      'SELECT COUNT(*)::int AS count FROM booking_equipment WHERE booking_id = $1',
      [roomOnlyBooking.id],
    )
    assert.equal(Number(roomOnlyLines[0].count), 0)
    const roomOnlyAudit = await dataSource.query(
      'SELECT action, old_status, new_status, performed_by FROM audit_log WHERE booking_id = $1',
      [roomOnlyBooking.id],
    )
    assert.equal(roomOnlyAudit.length, 1)
    assert.equal(roomOnlyAudit[0].action, 'CREATE')
    assert.equal(roomOnlyAudit[0].old_status, null)
    assert.equal(roomOnlyAudit[0].new_status, 'PENDING')
    assert.equal(roomOnlyAudit[0].performed_by, employeeId)
    console.log(`PASS 8 room-only happy path: ${roomOnlyBooking.id} PENDING, audit CREATE`)

    const multiEquipmentId1 = await createEquipment(4)
    const multiEquipmentId2 = await createEquipment(5)
    const multiBooking = await service.createBooking(
      employeeId,
      baseInput(roomId, futureWindow(70), {
        numberOfAttendees: 2,
        equipment: [
          { equipmentId: multiEquipmentId1, quantity: 2 },
          { equipmentId: multiEquipmentId2, quantity: 3 },
        ],
      }),
    )
    assert.equal(multiBooking.status, 'PENDING')
    const multiLines = await dataSource.query(
      'SELECT equipment_id, quantity FROM booking_equipment WHERE booking_id = $1 ORDER BY equipment_id',
      [multiBooking.id],
    )
    const actualLines: Array<[string, number]> = multiLines.map((line: { equipment_id: string; quantity: number }) => [
      line.equipment_id,
      Number(line.quantity),
    ])
    const expectedLines: Array<[string, number]> = [
      [multiEquipmentId1, 2],
      [multiEquipmentId2, 3],
    ]
    expectedLines.sort(([left], [right]) => left.localeCompare(right))
    assert.deepEqual(actualLines, expectedLines)
    const multiAudit = await dataSource.query(
      'SELECT action, old_status, new_status, performed_by FROM audit_log WHERE booking_id = $1',
      [multiBooking.id],
    )
    assert.equal(multiAudit.length, 1)
    assert.equal(multiAudit[0].action, 'CREATE')
    assert.equal(multiAudit[0].new_status, 'PENDING')
    assert.equal(multiAudit[0].performed_by, employeeId)
    console.log(`PASS 9 room + multiple equipment happy path: ${multiBooking.id}, lines=${multiLines.length}, audit CREATE`)

    const beforeRollback: [number, number, number] = [
      await count('booking'),
      await count('booking_equipment'),
      await count('audit_log'),
    ]
    await assertFailure(
      '10 validation rollback',
      () => service.createBooking(employeeId, baseInput(capacityRoomId, futureWindow(76), { numberOfAttendees: 3 })),
      /room capacity exceeded/i,
    )
    await assertBookingWithoutRows('10 rollback proof', beforeRollback)

    console.log('ALL BOOKING CREATE VALIDATION TESTS PASSED')
  } finally {
    await cleanup()
    if (dataSource.isInitialized) {
      await dataSource.destroy()
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
