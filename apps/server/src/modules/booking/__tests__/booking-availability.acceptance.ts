import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { graphql, type ExecutionResult } from 'graphql'
import { buildSchema } from 'type-graphql'
import { authChecker } from '../../../auth/auth-checker'
import type { GraphQLContext } from '../../../common/graphql/context'
import { createLoaders } from '../../../loaders'
import { createDataSource } from '../../../config/data-source'
import { Booking } from '../booking.entity'
import { BookingStatus } from '@resource-booking/shared'
import { Employee } from '../../employee/employee.entity'
import { MeetingRoom } from '../../room/room.entity'
import { Equipment } from '../../equipment/equipment.entity'
import { getEquipmentFreeQuantity } from '../../booking/availability'
import { BookingResolver } from '../booking.resolver'
import { EmployeeResolver } from '../../employee/employee.resolver'
import { RoomResolver } from '../../room/room.resolver'
import { EquipmentResolver } from '../../equipment/equipment.resolver'
import { UserRole } from '../../rbac/user-role.entity'

function requireData<T>(result: ExecutionResult): T {
  assert.equal(result.errors, undefined, JSON.stringify(result.errors))
  assert.notEqual(result.data, null)
  return result.data as T
}

interface RoomAvailabilityData {
  roomAvailability: Array<{ id: string; startTime: string; endTime: string; purpose: string; status: string }>
}

interface EquipmentAvailabilityData {
  equipmentAvailability: { equipmentId: string; name: string; quantityAvailable: number; remainingAvailability: number }
}

interface EmployeeData {
  employee: { firstName: string; bookingHistory: Array<{ id: string; startTime: string; endTime: string; purpose: string; status: string }> }
}

async function main(): Promise<void> {
  const dataSource = createDataSource()
  await dataSource.initialize()
  dataSource.setOptions({ logging: false })

  const runId = randomUUID()
  const employeeIds: string[] = []
  const roomIds: string[] = []
  const equipmentIds: string[] = []

  try {
    const employeeRepository = dataSource.getRepository(Employee)
    const roomRepository = dataSource.getRepository(MeetingRoom)
    const equipmentRepository = dataSource.getRepository(Equipment)
    const bookingRepository = dataSource.getRepository(Booking)
    const userRoleRepository = dataSource.getRepository(UserRole)

    const roleRows = (await dataSource.query(
      "SELECT role_name, id FROM role WHERE role_name IN ('Employee', 'Admin')",
    )) as Array<{ role_name: string; id: string }>
    const employeeRoleId = roleRows.find((r) => r.role_name === 'Employee')?.id
    const adminRoleId = roleRows.find((r) => r.role_name === 'Admin')?.id
    assert.ok(employeeRoleId, 'Employee role required')
    assert.ok(adminRoleId, 'Admin role required')

    const owner = await employeeRepository.save(
      employeeRepository.create({
        firstName: `Owner${runId}`, lastName: 'Test',
        email: `owner-${runId}@resource.local`, password: 'hash',
      }),
    )
    employeeIds.push(owner.id)
    await userRoleRepository.save(userRoleRepository.create({ employeeId: owner.id, roleId: employeeRoleId }))

    const admin = await employeeRepository.save(
      employeeRepository.create({
        firstName: 'Admin', lastName: 'Test',
        email: `admin-${runId}@resource.local`, password: 'hash',
      }),
    )
    employeeIds.push(admin.id)
    await userRoleRepository.save(userRoleRepository.create({ employeeId: admin.id, roleId: adminRoleId }))

    const guest = await employeeRepository.save(
      employeeRepository.create({
        firstName: 'Guest', lastName: 'Test',
        email: `guest-${runId}@resource.local`, password: 'hash',
      }),
    )
    await userRoleRepository.save(userRoleRepository.create({ employeeId: guest.id, roleId: employeeRoleId }))

    const room = await roomRepository.save(
      roomRepository.create({ name: `Availability room ${runId}`, location: 'Test', capacity: 4, isActive: true }),
    )
    roomIds.push(room.id)

    const equipment = await equipmentRepository.save(
      equipmentRepository.create({ name: `Availability equipment ${runId}`, quantityAvailable: 3, isActive: true }),
    )
    equipmentIds.push(equipment.id)

    const now = new Date()
    const futureStart = new Date(now.getTime() + 48 * 60 * 60 * 1000)
    const futureEnd = new Date(futureStart.getTime() + 60 * 60 * 1000)
    const pendingStart = new Date(now.getTime() + 50 * 60 * 60 * 1000)
    const pendingEnd = new Date(pendingStart.getTime() + 60 * 60 * 1000)
    const rejectedStart = new Date(now.getTime() + 52 * 60 * 60 * 1000)
    const rejectedEnd = new Date(rejectedStart.getTime() + 60 * 60 * 1000)
    const pastStart = new Date(now.getTime() - 2 * 60 * 60 * 1000)
    const pastEnd = new Date(pastStart.getTime() + 60 * 60 * 1000)
    const eqStart = new Date(now.getTime() + 60 * 60 * 60 * 1000)
    const eqEnd = new Date(eqStart.getTime() + 60 * 60 * 1000)

    const bookingFn = async (employeeId: string, roomId: string, startTime: Date, endTime: Date, purpose: string, status: BookingStatus) => {
      const booking = await bookingRepository.save(bookingRepository.create({ employeeId, roomId, startTime, endTime, purpose, numberOfAttendees: 1, status }))
      await dataSource.query(`UPDATE booking SET created_at = NOW(), updated_at = NOW() WHERE id = $1`, [booking.id])
      return booking
    }

    const approved = await bookingFn(owner.id, room.id, futureStart, futureEnd, 'Approved booking', 'PENDING')
    await dataSource.query(`UPDATE booking SET status = 'APPROVED' WHERE id = $1`, [approved.id])

    const pending = await bookingFn(owner.id, room.id, pendingStart, pendingEnd, 'Pending booking', 'PENDING')
    await dataSource.query(`UPDATE booking SET status = 'PENDING' WHERE id = $1`, [pending.id])

    const rejected = await bookingFn(owner.id, room.id, rejectedStart, rejectedEnd, 'Rejected booking', 'PENDING')
    await dataSource.query(`UPDATE booking SET status = 'REJECTED' WHERE id = $1`, [rejected.id])

    const pastBooking = await bookingFn(owner.id, room.id, pastStart, pastEnd, 'Past booking', 'PENDING')
    await dataSource.query(`UPDATE booking SET status = 'COMPLETED' WHERE id = $1`, [pastBooking.id])

    const eqBooking = await bookingFn(admin.id, room.id, eqStart, eqEnd, 'Equipment booking', 'PENDING')
    await dataSource.query(`UPDATE booking SET status = 'APPROVED' WHERE id = $1`, [eqBooking.id])
    await dataSource.query(`INSERT INTO booking_equipment (booking_id, equipment_id, quantity) VALUES ($1, $2, $3)`, [eqBooking.id, equipment.id, 2])

    const schema = await buildSchema({ resolvers: [BookingResolver, EmployeeResolver, RoomResolver, EquipmentResolver], authChecker, validate: true })
    const allContext = { dataSource, auth: { employee: admin, permissionKeys: new Set<string>(['room:read', 'equipment:read', 'employee:read']) }, loaders: createLoaders(dataSource) } as unknown as GraphQLContext

    const ROOM_AVAILABILITY_QUERY = `query RoomAvailability($roomId: String!, $startDate: DateTimeISO!, $endDate: DateTimeISO!) { roomAvailability(roomId: $roomId, startDate: $startDate, endDate: $endDate) { id startTime endTime purpose status } }`
    const roomResult = requireData<RoomAvailabilityData>(await graphql({ schema, source: ROOM_AVAILABILITY_QUERY, contextValue: allContext, variableValues: { roomId: room.id, startDate: futureStart.toISOString(), endDate: pendingEnd.toISOString() } }))
    const roomItems = roomResult.roomAvailability ?? []
    assert.equal(roomItems.length, 2, `Expected 2 room availability items, got ${roomItems.length}`)
    const statuses = roomItems.map((i) => i.status).sort()
    assert.deepEqual(statuses, ['APPROVED', 'PENDING'], `Expected APPROVED and PENDING, got ${statuses.join(', ')}`)
    console.log('PASS room availability shows PENDING + APPROVED bookings, excludes REJECTED and COMPLETED')
    console.log(`PASS room availability returned ${roomItems.length} items`)

    const EQUIPMENT_AVAILABILITY_QUERY = `query EquipmentAvailability($equipmentId: String!, $startDate: DateTimeISO!, $endDate: DateTimeISO!) { equipmentAvailability(equipmentId: $equipmentId, startDate: $startDate, endDate: $endDate) { equipmentId name quantityAvailable remainingAvailability } }`
    const eqData = requireData<EquipmentAvailabilityData>(await graphql({ schema, source: EQUIPMENT_AVAILABILITY_QUERY, contextValue: allContext, variableValues: { equipmentId: equipment.id, startDate: eqStart.toISOString(), endDate: eqEnd.toISOString() } }))
    const eqItem = eqData.equipmentAvailability
    const directFreeQuantity = await getEquipmentFreeQuantity(dataSource.manager, equipment.id, eqStart, eqEnd)
    assert.equal(eqItem.remainingAvailability, directFreeQuantity, `Byte-identical proof: ${eqItem.remainingAvailability} vs ${directFreeQuantity}`)
    assert.equal(eqItem.quantityAvailable, equipment.quantityAvailable)
    assert.equal(eqItem.name, equipment.name)
    console.log(`PASS equipment availability byte-identical proof: ${eqItem.remainingAvailability} === ${directFreeQuantity}`)

    const EMPLOYEE_BOOKING_HISTORY_QUERY = `query EmployeeBookingHistory($id: String!) { employee(id: $id) { id firstName lastName bookingHistory { id startTime endTime purpose status } } }`
    const empData = requireData<EmployeeData>(await graphql({ schema, source: EMPLOYEE_BOOKING_HISTORY_QUERY, contextValue: allContext, variableValues: { id: owner.id } }))
    const empDetail = empData.employee
    assert.equal(empDetail.firstName, owner.firstName)
    const history = empDetail.bookingHistory
    assert.ok(history.length >= 4, `Expected at least 4 items, got ${history.length}`)
    const historyStatuses = history.map((h) => h.status).sort()
    assert.ok(historyStatuses.includes('APPROVED'))
    assert.ok(historyStatuses.includes('PENDING'))
    assert.ok(historyStatuses.includes('REJECTED'))
    assert.ok(historyStatuses.includes('COMPLETED'))
    console.log(`PASS employee booking history returned ${history.length} bookings with all statuses`)

    const noHistoryData = requireData<EmployeeData>(await graphql({ schema, source: EMPLOYEE_BOOKING_HISTORY_QUERY, contextValue: allContext, variableValues: { id: guest.id } }))
    assert.equal(noHistoryData.employee.bookingHistory.length, 0, 'Employee with no bookings should have empty history')
    console.log('PASS employee with no bookings returns empty bookingHistory')

    console.log('ALL BOOKING AVAILABILITY ACCEPTANCE TESTS PASSED')
  } finally {
    if (roomIds.length > 0) {
      const roomParams = roomIds.map((_, i) => `$${i + 1}`).join(',')
      await dataSource.query(`DELETE FROM booking_equipment WHERE booking_id IN (SELECT id FROM booking WHERE room_id IN (${roomParams}))`, roomIds)
      await dataSource.query(`DELETE FROM audit_log WHERE booking_id IN (SELECT id FROM booking WHERE room_id IN (${roomParams}))`, roomIds)
      await dataSource.query(`DELETE FROM booking WHERE room_id IN (${roomParams})`, roomIds)
      await dataSource.query(`DELETE FROM meeting_room WHERE id IN (${roomParams})`, roomIds)
    }
    if (equipmentIds.length > 0) {
      await dataSource.query(`DELETE FROM equipment WHERE id IN (${equipmentIds.map((_, i) => `$${i + 1}`).join(',')})`, equipmentIds)
    }
    if (employeeIds.length > 0) {
      await dataSource.query(`DELETE FROM user_role WHERE employee_id IN (${employeeIds.map((_, i) => `$${i + 1}`).join(',')})`, employeeIds)
      await dataSource.query(`DELETE FROM employee WHERE id IN (${employeeIds.map((_, i) => `$${i + 1}`).join(',')})`, employeeIds)
    }
    if (dataSource.isInitialized) { await dataSource.destroy() }
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
