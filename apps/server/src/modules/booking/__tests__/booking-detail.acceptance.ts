import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { DataSource, Logger } from 'typeorm'
import { createApp } from '../../../app'
import { createDataSource } from '../../../config/data-source'
import { signEmployeeToken } from '../../../auth/jwt'
import { AuditLog, type AuditAction } from '../../audit/audit-log.entity'
import { Booking } from '../booking.entity'
import { BookingEquipment } from '../booking-equipment.entity'
import { Employee } from '../../employee/employee.entity'
import { Equipment } from '../../equipment/equipment.entity'
import { MeetingRoom } from '../../room/room.entity'
import { UserRole } from '../../rbac/user-role.entity'
import { getEquipmentFreeQuantity } from '../availability'
import type { BookingStatus } from '@resource-booking/shared'

interface GqlError {
  message: string
  path?: Array<string | number>
  extensions?: Record<string, unknown>
}

interface BookingSummary {
  id: string
  startTime: string
  endTime: string
  purpose: string
  status: BookingStatus
}

interface Actor {
  id: string | null
  name: string
}

interface Transition {
  id: string
  oldStatus: BookingStatus | null
  newStatus: BookingStatus
  actor: Actor
  transitionedAt: string
}

interface BookingDetail {
  id: string
  employeeId: string | null
  roomId: string
  startTime: string
  endTime: string
  purpose: string
  rejectionReason: string | null
  numberOfAttendees: number
  status: BookingStatus
  createdAt: string
  processedAt: string | null
  processedBy: Actor | null
  statusHistory: Transition[]
  requester: {
    id: string | null
    name: string
    email: string
    recentBookings: BookingSummary[]
  }
  room: {
    id: string
    name: string
    location: string
    capacity: number
    otherBookings: BookingSummary[]
  }
  equipmentLines: Array<{
    id: string
    equipmentId: string
    name: string
    requestedQuantity: number
    remainingAvailability: number
  }>
}

interface GqlResult {
  status: number
  body: {
    data?: Record<string, BookingDetail | null> | null
    errors?: GqlError[]
  }
}

interface RoomBatchResult {
  status: number
  body: {
    data?: {
      bookings: {
        items: Array<{
          id: string
          room: {
            id: string
            otherBookings: Array<{ id: string }>
          }
        }>
      }
    } | null
    errors?: GqlError[]
  }
}

const DETAIL_QUERY = `
  query BookingDetail($id: ID!) {
    booking(id: $id) {
      id
      employeeId
      roomId
      startTime
      endTime
      purpose
      rejectionReason
      numberOfAttendees
      status
      createdAt
      processedAt
      processedBy { id name }
      statusHistory {
        id
        oldStatus
        newStatus
        actor { id name }
        transitionedAt
      }
      requester {
        id
        name
        email
        recentBookings { id startTime endTime purpose status }
      }
      room {
        id
        name
        location
        capacity
        otherBookings { id startTime endTime purpose status }
      }
      equipmentLines {
        id
        equipmentId
        name
        requestedQuantity
        remainingAvailability
      }
    }
  }
`

const MULTI_ROOM_DETAIL_QUERY = `
  query MultiRoomBookingDetail($firstId: ID!, $secondId: ID!) {
    first: booking(id: $firstId) {
      id
      room {
        id
        otherBookings { id }
      }
    }
    second: booking(id: $secondId) {
      id
      room {
        id
        otherBookings { id }
      }
    }
  }
`

const ROOM_BATCH_QUERY = `
  query BookingRoomBatch($search: String!) {
    bookings(page: 1, pageSize: 100, filter: { search: $search }) {
      items {
        id
        room {
          id
          otherBookings { id }
        }
      }
    }
  }
`

async function main(): Promise<void> {
  const dataSource = createDataSource()
  const queryLog: string[] = []
  let captureQueries = false
  const logger: Logger = {
    logQuery(query) {
      if (captureQueries) {
        queryLog.push(query)
      }
    },
    logQueryError() {},
    logQuerySlow() {},
    logSchemaBuild() {},
    logMigration() {},
    log() {},
  }
  const employeeIds: string[] = []
  const roomIds: string[] = []
  const equipmentIds: string[] = []
  const runId = randomUUID()
  let server: Server | undefined
  let port = 0

  async function createEmployee(firstName: string, lastName: string): Promise<Employee> {
    const repository = dataSource.getRepository(Employee)
    const employee = await repository.save(
      repository.create({
        firstName,
        lastName,
        email: `booking-detail-${firstName}-${lastName}-${runId}@resource.local`,
        password: 'unused-acceptance-hash',
      }),
    )
    employeeIds.push(employee.id)
    return employee
  }

  async function createRoom(name: string, location: string, capacity: number): Promise<MeetingRoom> {
    const repository = dataSource.getRepository(MeetingRoom)
    const room = await repository.save(
      repository.create({ name: `${name} ${runId}`, location, capacity, isActive: true }),
    )
    roomIds.push(room.id)
    return room
  }

  async function createEquipment(name: string, quantityAvailable: number): Promise<Equipment> {
    const repository = dataSource.getRepository(Equipment)
    const equipment = await repository.save(
      repository.create({ name: `${name} ${runId}`, quantityAvailable, isActive: true }),
    )
    equipmentIds.push(equipment.id)
    return equipment
  }

  async function createBooking(input: {
    employeeId: string | null
    roomId: string
    startTime: Date
    endTime: Date
    purpose: string
    numberOfAttendees: number
    status: BookingStatus
    rejectionReason?: string | null
    createdAt: Date
  }): Promise<Booking> {
    const repository = dataSource.getRepository(Booking)
    const booking = await repository.save(
      repository.create({
        employeeId: input.employeeId,
        roomId: input.roomId,
        startTime: input.startTime,
        endTime: input.endTime,
        purpose: input.purpose,
        numberOfAttendees: input.numberOfAttendees,
        status: input.status,
        rejectionReason: input.rejectionReason ?? null,
      }),
    )
    await dataSource.query('UPDATE booking SET created_at = $2, updated_at = $2 WHERE id = $1', [
      booking.id,
      input.createdAt,
    ])
    return booking
  }

  async function createAudit(input: {
    bookingId: string
    action: AuditAction
    oldStatus: BookingStatus | null
    newStatus: BookingStatus
    performedById: string | null
    createdAt: Date
  }): Promise<AuditLog> {
    const repository = dataSource.getRepository(AuditLog)
    return repository.save(
      repository.create({
        bookingId: input.bookingId,
        action: input.action,
        oldStatus: input.oldStatus,
        newStatus: input.newStatus,
        performedById: input.performedById,
        createdAt: input.createdAt,
      }),
    )
  }

  async function addEquipment(bookingId: string, equipmentId: string, quantity: number): Promise<void> {
    const repository = dataSource.getRepository(BookingEquipment)
    await repository.save(repository.create({ bookingId, equipmentId, quantity }))
  }

  async function cleanup(): Promise<void> {
    if (roomIds.length > 0) {
      const params = roomIds.map((_, index) => `$${index + 1}`).join(',')
      await dataSource.query(
        `DELETE FROM audit_log WHERE booking_id IN (SELECT id FROM booking WHERE room_id IN (${params}))`,
        roomIds,
      )
      await dataSource.query(
        `DELETE FROM booking_equipment WHERE booking_id IN (SELECT id FROM booking WHERE room_id IN (${params}))`,
        roomIds,
      )
      await dataSource.query(`DELETE FROM booking WHERE room_id IN (${params})`, roomIds)
      await dataSource.query(`DELETE FROM meeting_room WHERE id IN (${params})`, roomIds)
    }
    if (equipmentIds.length > 0) {
      const params = equipmentIds.map((_, index) => `$${index + 1}`).join(',')
      await dataSource.query(`DELETE FROM equipment WHERE id IN (${params})`, equipmentIds)
    }
    if (employeeIds.length > 0) {
      const params = employeeIds.map((_, index) => `$${index + 1}`).join(',')
      await dataSource.query(`DELETE FROM user_role WHERE employee_id IN (${params})`, employeeIds)
      await dataSource.query(`DELETE FROM employee WHERE id IN (${params})`, employeeIds)
    }
  }

  async function gql(token: string, bookingId: string): Promise<GqlResult> {
    const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: DETAIL_QUERY, variables: { id: bookingId } }),
    })
    return { status: response.status, body: (await response.json()) as GqlResult['body'] }
  }

  async function gqlMultipleRooms(
    token: string,
    firstBookingId: string,
    secondBookingId: string,
  ): Promise<GqlResult> {
    const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: MULTI_ROOM_DETAIL_QUERY,
        variables: { firstId: firstBookingId, secondId: secondBookingId },
      }),
    })
    return { status: response.status, body: (await response.json()) as GqlResult['body'] }
  }

  async function gqlRoomBatch(token: string, search: string): Promise<RoomBatchResult> {
    const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: ROOM_BATCH_QUERY, variables: { search } }),
    })
    return { status: response.status, body: (await response.json()) as RoomBatchResult['body'] }
  }

  async function captureGraphQLQueries<T>(
    operation: () => Promise<T>,
  ): Promise<{ value: T; queries: string[] }> {
    captureQueries = true
    const firstQueryIndex = queryLog.length
    try {
      const value = await operation()
      return { value, queries: queryLog.slice(firstQueryIndex) }
    } finally {
      captureQueries = false
    }
  }

  function detailOf(result: GqlResult): BookingDetail {
    assert.equal(result.status, 200)
    assert.equal(result.body.errors, undefined, JSON.stringify(result.body.errors))
    assert.ok(result.body.data?.booking, JSON.stringify(result.body))
    return result.body.data.booking
  }

  function securityErrorsOf(result: GqlResult): Array<{
    message: string
    path?: Array<string | number>
    extensions: Record<string, unknown>
  }> {
    return (result.body.errors ?? []).map((error) => ({
      message: error.message,
      path: error.path,
      extensions: { code: error.extensions?.code },
    }))
  }

  dataSource.setOptions({ logging: true, logger })
  if (!dataSource.isInitialized) {
    await dataSource.initialize()
  }

  try {
    const roleRows = (await dataSource.query(
      "SELECT role_name, id FROM role WHERE role_name IN ('Employee', 'Admin')",
    )) as Array<{ role_name: string; id: string }>
    const employeeRoleId = roleRows.find((role) => role.role_name === 'Employee')?.id
    const adminRoleId = roleRows.find((role) => role.role_name === 'Admin')?.id
    assert.ok(employeeRoleId, 'seeded Employee role is required')
    assert.ok(adminRoleId, 'seeded Admin role is required')

    const owner = await createEmployee('Detail', 'Owner')
    const other = await createEmployee('Detail', 'Other')
    const approver = await createEmployee('Detail', 'Approver')
    const deletedApprover = await createEmployee('Deleted', 'Approver')
    const deletedRequester = await createEmployee('Deleted', 'Requester')
    const userRoleRepository = dataSource.getRepository(UserRole)
    await userRoleRepository.save([
      userRoleRepository.create({ employeeId: owner.id, roleId: employeeRoleId }),
      userRoleRepository.create({ employeeId: other.id, roleId: employeeRoleId }),
      userRoleRepository.create({ employeeId: approver.id, roleId: adminRoleId }),
    ])

    const detailRoom = await createRoom('Detail room', 'North Wing', 8)
    const recentRoom = await createRoom('Recent room', 'South Wing', 12)
    const projector = await createEquipment('Projector', 4)
    const whiteboard = await createEquipment('Whiteboard', 2)
    const camera = await createEquipment('Camera', 5)
    const base = new Date()
    const mainStart = new Date(base.getTime() + 24 * 60 * 60 * 1000)
    const mainEnd = new Date(mainStart.getTime() + 60 * 60 * 1000)
    const mainCreatedAt = new Date(base.getTime() - 3 * 60 * 60 * 1000)
    const rejectionAt = new Date(mainCreatedAt.getTime() + 5 * 60 * 1000)

    const approvedWithDeletedActor = await createBooking({
      employeeId: owner.id,
      roomId: recentRoom.id,
      startTime: new Date(base.getTime() + 80 * 60 * 60 * 1000),
      endTime: new Date(base.getTime() + 81 * 60 * 60 * 1000),
      purpose: 'Approved booking with deleted processing actor',
      numberOfAttendees: 2,
      status: 'COMPLETED',
      createdAt: new Date(base.getTime() - 60 * 60 * 1000),
    })
    const approvedAt = new Date(base.getTime() - 59 * 60 * 1000)
    const completedAt = new Date(base.getTime() - 58 * 60 * 1000)
    await createAudit({
      bookingId: approvedWithDeletedActor.id,
      action: 'CREATE',
      oldStatus: null,
      newStatus: 'PENDING',
      performedById: owner.id,
      createdAt: new Date(base.getTime() - 61 * 60 * 1000),
    })
    await createAudit({
      bookingId: approvedWithDeletedActor.id,
      action: 'APPROVE',
      oldStatus: 'PENDING',
      newStatus: 'APPROVED',
      performedById: deletedApprover.id,
      createdAt: approvedAt,
    })
    await createAudit({
      bookingId: approvedWithDeletedActor.id,
      action: 'COMPLETE',
      oldStatus: 'APPROVED',
      newStatus: 'COMPLETED',
      performedById: approver.id,
      createdAt: completedAt,
    })
    await dataSource.getRepository(Employee).delete({ id: deletedApprover.id })

    const main = await createBooking({
      employeeId: owner.id,
      roomId: detailRoom.id,
      startTime: mainStart,
      endTime: mainEnd,
      purpose: 'Quarterly planning review',
      numberOfAttendees: 6,
      status: 'REJECTED',
      rejectionReason: 'Room capacity is below the required attendance',
      createdAt: mainCreatedAt,
    })
    await addEquipment(main.id, projector.id, 1)
    await addEquipment(main.id, whiteboard.id, 1)
    await createAudit({
      bookingId: main.id,
      action: 'CREATE',
      oldStatus: null,
      newStatus: 'PENDING',
      performedById: owner.id,
      createdAt: mainCreatedAt,
    })
    await createAudit({
      bookingId: main.id,
      action: 'REJECT',
      oldStatus: 'PENDING',
      newStatus: 'REJECTED',
      performedById: approver.id,
      createdAt: rejectionAt,
    })

    const overlapping = await createBooking({
      employeeId: other.id,
      roomId: detailRoom.id,
      startTime: new Date(mainStart.getTime() + 30 * 60 * 1000),
      endTime: new Date(mainEnd.getTime() + 30 * 60 * 1000),
      purpose: 'Approved overlap permitted because detail booking is rejected',
      numberOfAttendees: 2,
      status: 'APPROVED',
      createdAt: new Date(base.getTime() - 2 * 60 * 60 * 1000),
    })
    await addEquipment(overlapping.id, projector.id, 2)

    const crossRoomOverlap = await createBooking({
      employeeId: other.id,
      roomId: recentRoom.id,
      startTime: mainStart,
      endTime: mainEnd,
      purpose: 'Overlap in a different room',
      numberOfAttendees: 2,
      status: 'REJECTED',
      createdAt: new Date(base.getTime() - 90 * 60 * 1000),
    })

    const roomBatchPurpose = `Room batch ${runId}`
    const roomBatchStart = new Date(base.getTime() + 120 * 60 * 60 * 1000)
    const roomBatchEnd = new Date(roomBatchStart.getTime() + 60 * 60 * 1000)
    const firstRoomBatchBooking = await createBooking({
      employeeId: owner.id,
      roomId: detailRoom.id,
      startTime: roomBatchStart,
      endTime: roomBatchEnd,
      purpose: roomBatchPurpose,
      numberOfAttendees: 1,
      status: 'REJECTED',
      createdAt: new Date(base.getTime() - 100 * 60 * 1000),
    })
    const secondRoomBatchBooking = await createBooking({
      employeeId: other.id,
      roomId: recentRoom.id,
      startTime: roomBatchStart,
      endTime: roomBatchEnd,
      purpose: roomBatchPurpose,
      numberOfAttendees: 1,
      status: 'REJECTED',
      createdAt: new Date(base.getTime() - 99 * 60 * 1000),
    })

    const recentBookings: Booking[] = []
    for (let index = 1; index <= 6; index += 1) {
      const startTime = new Date(base.getTime() + (48 + (index - 1) * 4) * 60 * 60 * 1000)
      const booking = await createBooking({
        employeeId: owner.id,
        roomId: recentRoom.id,
        startTime,
        endTime: new Date(startTime.getTime() + 30 * 60 * 1000),
        purpose: `Recent booking ${String(index)}`,
        numberOfAttendees: 1,
        status: 'PENDING',
        createdAt: new Date(base.getTime() + index * 60 * 1000),
      })
      recentBookings.push(booking)
    }

    const deletedRequesterBooking = await createBooking({
      employeeId: deletedRequester.id,
      roomId: recentRoom.id,
      startTime: new Date(base.getTime() + 90 * 60 * 60 * 1000),
      endTime: new Date(base.getTime() + 91 * 60 * 60 * 1000),
      purpose: 'Booking retained after requester deletion',
      numberOfAttendees: 1,
      status: 'PENDING',
      createdAt: new Date(base.getTime() - 30 * 60 * 1000),
    })
    await createAudit({
      bookingId: deletedRequesterBooking.id,
      action: 'CREATE',
      oldStatus: null,
      newStatus: 'PENDING',
      performedById: deletedRequester.id,
      createdAt: new Date(base.getTime() - 30 * 60 * 1000),
    })
    await dataSource.getRepository(Employee).delete({ id: deletedRequester.id })

    const app = await createApp(dataSource)
    const httpServer = app.listen(0, '127.0.0.1')
    server = httpServer
    await new Promise<void>((resolve) => httpServer.once('listening', resolve))
    port = (httpServer.address() as AddressInfo).port

    const ownerToken = signEmployeeToken(owner.id)
    const otherToken = signEmployeeToken(other.id)
    const adminToken = signEmployeeToken(approver.id)
    const initialMainRequest = await captureGraphQLQueries(() => gql(adminToken, main.id))
    const mainDetail = detailOf(initialMainRequest.value)
    const initialEquipmentQueryCount = initialMainRequest.queries.filter((query) =>
      query.toLowerCase().includes('booking_equipment'),
    ).length
    assert.ok(initialMainRequest.queries.length > 0)
    assert.ok(initialEquipmentQueryCount >= 2)

    assert.equal(mainDetail.employeeId, owner.id)
    assert.equal(mainDetail.roomId, detailRoom.id)
    assert.equal(mainDetail.startTime, mainStart.toISOString())
    assert.equal(mainDetail.endTime, mainEnd.toISOString())
    assert.equal(mainDetail.purpose, 'Quarterly planning review')
    assert.equal(mainDetail.numberOfAttendees, 6)
    assert.equal(mainDetail.status, 'REJECTED')
    assert.equal(mainDetail.rejectionReason, 'Room capacity is below the required attendance')
    assert.equal(mainDetail.createdAt, mainCreatedAt.toISOString())
    assert.equal(mainDetail.processedAt, rejectionAt.toISOString())
    assert.deepEqual(mainDetail.processedBy, { id: approver.id, name: 'Detail Approver' })
    assert.deepEqual(
      mainDetail.statusHistory.map((entry) => [entry.oldStatus, entry.newStatus, entry.actor.name]),
      [
        [null, 'PENDING', 'Detail Owner'],
        ['PENDING', 'REJECTED', 'Detail Approver'],
      ],
    )
    assert.deepEqual(
      mainDetail.statusHistory.map((entry) => entry.transitionedAt),
      [mainCreatedAt.toISOString(), rejectionAt.toISOString()],
    )
    assert.deepEqual(mainDetail.requester, {
      id: owner.id,
      name: 'Detail Owner',
      email: mainDetail.requester.email,
      recentBookings: [...recentBookings]
        .slice(1)
        .reverse()
        .map((booking) => ({
          id: booking.id,
          startTime: booking.startTime.toISOString(),
          endTime: booking.endTime.toISOString(),
          purpose: booking.purpose,
          status: booking.status,
        })),
    })
    assert.equal(mainDetail.requester.email, `booking-detail-Detail-Owner-${runId}@resource.local`)
    assert.equal(mainDetail.room.name, `Detail room ${runId}`)
    assert.equal(mainDetail.room.location, 'North Wing')
    assert.equal(mainDetail.room.capacity, 8)
    assert.deepEqual(
      mainDetail.room.otherBookings.map((booking) => booking.id),
      [overlapping.id],
    )
    assert.deepEqual(
      detailOf(await gql(ownerToken, main.id)).room.otherBookings,
      [],
    )

    const multiRoomRequest = await captureGraphQLQueries(() =>
      gqlMultipleRooms(adminToken, main.id, crossRoomOverlap.id),
    )
    assert.equal(multiRoomRequest.value.status, 200)
    assert.equal(multiRoomRequest.value.body.errors, undefined, JSON.stringify(multiRoomRequest.value.body.errors))
    assert.ok(multiRoomRequest.value.body.data, JSON.stringify(multiRoomRequest.value.body))
    assert.deepEqual(
      multiRoomRequest.value.body.data.first?.room.otherBookings.map((booking) => booking.id),
      [overlapping.id],
    )
    assert.deepEqual(
      multiRoomRequest.value.body.data.second?.room.otherBookings,
      [],
    )
    const roomBatchRequest = await captureGraphQLQueries(() =>
      gqlRoomBatch(adminToken, roomBatchPurpose),
    )
    assert.equal(roomBatchRequest.value.status, 200)
    assert.equal(roomBatchRequest.value.body.errors, undefined, JSON.stringify(roomBatchRequest.value.body.errors))
    assert.ok(roomBatchRequest.value.body.data, JSON.stringify(roomBatchRequest.value.body))
    const roomBatchItems = new Map(
      roomBatchRequest.value.body.data.bookings.items.map((booking) => [booking.id, booking] as const),
    )
    assert.deepEqual(roomBatchItems.get(firstRoomBatchBooking.id)?.room.otherBookings, [])
    assert.deepEqual(roomBatchItems.get(secondRoomBatchBooking.id)?.room.otherBookings, [])
    assert.equal(
      roomBatchRequest.queries.filter(
        (query) =>
          query.includes('"booking"."room_id" = $') &&
          query.includes('"booking"."start_time" < $') &&
          query.includes('"booking"."end_time" > $'),
      ).length,
      1,
      roomBatchRequest.queries.join('\n'),
    )

    const equipmentByName = new Map(
      mainDetail.equipmentLines.map((line) => [line.name, line] as const),
    )
    assert.equal(equipmentByName.get(`Projector ${runId}`)?.requestedQuantity, 1)
    assert.equal(equipmentByName.get(`Whiteboard ${runId}`)?.requestedQuantity, 1)
    assert.equal(
      equipmentByName.get(`Projector ${runId}`)?.remainingAvailability,
      await getEquipmentFreeQuantity(dataSource.manager, projector.id, mainStart, mainEnd),
    )
    assert.equal(equipmentByName.get(`Projector ${runId}`)?.remainingAvailability, 2)
    assert.equal(equipmentByName.get(`Whiteboard ${runId}`)?.remainingAvailability, 2)

    await addEquipment(main.id, camera.id, 1)
    const expandedMainRequest = await captureGraphQLQueries(() => gql(adminToken, main.id))
    const expandedMainDetail = detailOf(expandedMainRequest.value)
    const expandedEquipmentQueryCount = expandedMainRequest.queries.filter((query) =>
      query.toLowerCase().includes('booking_equipment'),
    ).length
    assert.equal(
      expandedMainRequest.queries.length,
      initialMainRequest.queries.length,
      `detail queries with two equipment lines=${String(initialMainRequest.queries.length)}, with three=${String(expandedMainRequest.queries.length)}`,
    )
    assert.equal(expandedEquipmentQueryCount, initialEquipmentQueryCount)
    assert.equal(expandedMainDetail.equipmentLines.length, 3)

    const deletedActorDetail = detailOf(await gql(ownerToken, approvedWithDeletedActor.id))
    assert.equal(deletedActorDetail.status, 'COMPLETED')
    assert.equal(deletedActorDetail.processedAt, approvedAt.toISOString())
    assert.deepEqual(deletedActorDetail.processedBy, { id: null, name: 'Deleted user' })
    assert.deepEqual(
      deletedActorDetail.statusHistory.map((entry) => entry.actor.name),
      ['Detail Owner', 'Deleted user', 'Detail Approver'],
    )

    const deletedRequesterDetail = detailOf(await gql(adminToken, deletedRequesterBooking.id))
    assert.equal(deletedRequesterDetail.employeeId, null)
    assert.deepEqual(deletedRequesterDetail.requester, {
      id: null,
      name: 'Deleted user',
      email: 'Deleted user',
      recentBookings: [],
    })
    assert.deepEqual(
      deletedRequesterDetail.statusHistory.map((entry) => entry.actor),
      [{ id: null, name: 'Deleted user' }],
    )

    const foreign = await gql(otherToken, main.id)
    const missing = await gql(otherToken, randomUUID())
    const malformed = await gql(otherToken, 'not-a-uuid')
    for (const denied of [foreign, missing, malformed]) {
      assert.equal(denied.status, 200)
      assert.equal(denied.body.data, null)
      assert.deepEqual(securityErrorsOf(denied), [
        { message: 'Not authorised', path: ['booking'], extensions: { code: 'FORBIDDEN' } },
      ])
    }

    console.log('PASS FR-45–49 booking detail fields, processing audit, requester, room, and equipment')
    console.log('PASS deleted requester and deleted audit actor use the shared Deleted user fallback')
    console.log('PASS nested room bookings preserve the caller read scope')
    console.log('PASS batched room overlap results stay isolated by room and read scope')
    console.log('PASS direct lookup preserves own/all read-scope indistinguishability')
    console.log('BOOKING DETAIL ACCEPTANCE PASSED')
  } finally {
    if (server !== undefined) {
      const activeServer = server
      await new Promise<void>((resolve, reject) => {
        activeServer.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    }
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
