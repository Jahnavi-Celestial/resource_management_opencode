import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { graphql, type ExecutionResult } from 'graphql'
import { buildSchema } from 'type-graphql'
import { authChecker } from '../../../auth/auth-checker'
import type { GraphQLContext } from '../../../common/graphql/context'
import { createLoaders } from '../../../loaders'
import { createDataSource } from '../../../config/data-source'
import { BookingEquipment } from '../booking-equipment.entity'
import { Booking } from '../booking.entity'
import { BookingResolver } from '../booking.resolver'
import { Employee } from '../../employee/employee.entity'
import { Equipment } from '../../equipment/equipment.entity'
import { MeetingRoom } from '../../room/room.entity'

type BookingListItem = {
  id: string
  employeeId: string | null
  startTime: string
  purpose: string
  status: string
  requester: {
    id: string | null
    name: string
  }
  room: {
    id: string
    name: string
  }
  equipmentLines: Array<{
    equipmentId: string
    requestedQuantity: number
  }>
}

type BookingListData = {
  bookings: {
    totalCount: number
    items: BookingListItem[]
  }
}

type BookingData = {
  booking: Pick<BookingListItem, 'id' | 'employeeId' | 'purpose' | 'status'> | null
}

type BookingFilter = {
  search?: string
  status?: string
  startDate?: string
  endDate?: string
}

const listQuery = `
  query BookingList($page: Int!, $pageSize: Int!, $sort: SortInput, $filter: BookingFilterInput) {
    bookings(page: $page, pageSize: $pageSize, sort: $sort, filter: $filter) {
      totalCount
      items {
        id
        employeeId
        startTime
        purpose
        status
        requester { id name }
        room { id name }
        equipmentLines { equipmentId requestedQuantity }
      }
    }
  }
`

const detailQuery = `
  query BookingDetail($id: ID!) {
    booking(id: $id) {
      id
      employeeId
      purpose
      status
    }
  }
`

function requireData<T>(result: ExecutionResult): T {
  assert.equal(result.errors, undefined, JSON.stringify(result.errors))
  assert.notEqual(result.data, null)
  return result.data as T
}

function responseSignature(result: ExecutionResult): unknown {
  return {
    data: result.data,
    errors: result.errors?.map((error) => ({
      message: error.message,
      path: error.path,
      extensions: error.extensions,
    })),
  }
}

async function main(): Promise<void> {
  const dataSource = createDataSource()
  await dataSource.initialize()
  dataSource.setOptions({ logging: false })

  const runId = randomUUID().slice(0, 8)
  const ownName = `Own${runId}`
  const otherName = `Other${runId}`
  const roomName = `Quanta ${runId}`
  const equipmentName = `Flux ${runId}`
  const purpose = `Temporal ${runId}`
  const employeeRepository = dataSource.getRepository(Employee)
  const roomRepository = dataSource.getRepository(MeetingRoom)
  const equipmentRepository = dataSource.getRepository(Equipment)
  const bookingRepository = dataSource.getRepository(Booking)
  const bookingEquipmentRepository = dataSource.getRepository(BookingEquipment)
  let ownEmployeeId: string | null = null
  let otherEmployeeId: string | null = null
  let roomId: string | null = null
  let equipmentId: string | null = null
  const bookingIds: string[] = []

  try {
    const savedEmployees = await employeeRepository.save([
      employeeRepository.create({
        firstName: ownName,
        lastName: 'Requester',
        email: `own-${runId}@example.test`,
        password: '$2b$12$booking.list.acceptance.password.hash.0000000000000000000000',
      }),
      employeeRepository.create({
        firstName: otherName,
        lastName: 'Requester',
        email: `other-${runId}@example.test`,
        password: '$2b$12$booking.list.acceptance.password.hash.0000000000000000000000',
      }),
    ])
    const ownEmployee = savedEmployees[0]
    const otherEmployee = savedEmployees[1]
    if (ownEmployee === undefined || otherEmployee === undefined) {
      throw new Error('Booking-list employee fixture creation returned too few rows')
    }
    ownEmployeeId = ownEmployee.id
    otherEmployeeId = otherEmployee.id

    const room = await roomRepository.save(
      roomRepository.create({
        name: roomName,
        location: `Lab ${runId}`,
        capacity: 20,
        isActive: true,
      }),
    )
    roomId = room.id
    const equipment = await equipmentRepository.save(
      equipmentRepository.create({
        name: equipmentName,
        quantityAvailable: 2,
        isActive: true,
      }),
    )
    equipmentId = equipment.id

    const fixtures = [
      {
        employeeId: ownEmployee.id,
        startTime: new Date('2031-01-10T10:00:00.000Z'),
        endTime: new Date('2031-01-10T11:00:00.000Z'),
        status: 'CANCELLED' as const,
        purpose: `Agenda ${runId} cancelled`,
      },
      {
        employeeId: otherEmployee.id,
        startTime: new Date('2031-01-11T10:00:00.000Z'),
        endTime: new Date('2031-01-11T11:00:00.000Z'),
        status: 'REJECTED' as const,
        purpose,
      },
      {
        employeeId: ownEmployee.id,
        startTime: new Date('2031-01-12T10:00:00.000Z'),
        endTime: new Date('2031-01-12T11:00:00.000Z'),
        status: 'PENDING' as const,
        purpose: `Agenda ${runId} pending`,
      },
    ]
    const bookings = await bookingRepository.save(
      fixtures.map((fixture) =>
        bookingRepository.create({
          employeeId: fixture.employeeId,
          roomId: room.id,
          startTime: fixture.startTime,
          endTime: fixture.endTime,
          purpose: fixture.purpose,
          numberOfAttendees: 2,
          status: fixture.status,
          rejectionReason: fixture.status === 'REJECTED' ? 'Acceptance rejection reason' : null,
        }),
      ),
    )
    const firstBooking = bookings[0]
    const secondBooking = bookings[1]
    const thirdBooking = bookings[2]
    if (firstBooking === undefined || secondBooking === undefined || thirdBooking === undefined) {
      throw new Error('Booking-list booking fixture creation returned too few rows')
    }
    bookingIds.push(...bookings.map((booking) => booking.id))
    await bookingEquipmentRepository.save(
      bookingEquipmentRepository.create({
        bookingId: secondBooking.id,
        equipmentId: equipment.id,
        quantity: 1,
      }),
    )

    const schema = await buildSchema({ resolvers: [BookingResolver], authChecker })
    const allContext = {
      dataSource,
      auth: {
        employee: ownEmployee,
        permissionKeys: new Set<string>(['booking:read:all']),
      },
      loaders: createLoaders(dataSource),
    } as unknown as GraphQLContext
    const ownContext = {
      dataSource,
      auth: {
        employee: ownEmployee,
        permissionKeys: new Set<string>(['booking:read:own']),
      },
      loaders: createLoaders(dataSource),
    } as unknown as GraphQLContext

    const executeList = async (
      context: GraphQLContext,
      filter: BookingFilter | null = null,
      page = 1,
      pageSize = 20,
      sort: { field: string; direction: 'ASC' | 'DESC' } | null = null,
    ): Promise<BookingListData> =>
      requireData(
        await graphql({
          schema,
          source: listQuery,
          contextValue: context,
          variableValues: { page, pageSize, sort, filter },
        }),
      )

    const allBookings = await executeList(allContext, null, 1, 100)
    assert.equal(allBookings.bookings.totalCount, 3)
    assert.deepEqual(
      new Set(allBookings.bookings.items.map((booking) => booking.employeeId)),
      new Set([ownEmployee.id, otherEmployee.id]),
    )
    const allBookingsById = new Map(
      allBookings.bookings.items.map((booking) => [booking.id, booking] as const),
    )
    assert.equal(allBookingsById.get(firstBooking.id)?.requester.name, `${ownName} Requester`)
    assert.equal(allBookingsById.get(secondBooking.id)?.requester.name, `${otherName} Requester`)
    assert.equal(allBookingsById.get(firstBooking.id)?.room.id, room.id)
    assert.equal(allBookingsById.get(firstBooking.id)?.room.name, roomName)
    assert.deepEqual(allBookingsById.get(firstBooking.id)?.equipmentLines, [])
    const secondBookingEquipmentLines = allBookingsById.get(secondBooking.id)?.equipmentLines ?? []
    assert.equal(secondBookingEquipmentLines.length, 1)
    assert.equal(secondBookingEquipmentLines[0]?.equipmentId, equipment.id)
    assert.equal(secondBookingEquipmentLines[0]?.requestedQuantity, 1)

    const ownBookings = await executeList(ownContext)
    assert.equal(ownBookings.bookings.totalCount, 2)
    assert.ok(ownBookings.bookings.items.every((booking) => booking.employeeId === ownEmployee.id))
    assert.ok(!ownBookings.bookings.items.some((booking) => booking.id === secondBooking.id))

    const searches = new Map<string, string[]>([
      [otherName, [secondBooking.id]],
      [roomName, [firstBooking.id, secondBooking.id, thirdBooking.id]],
      [equipmentName, [secondBooking.id]],
      [purpose, [secondBooking.id]],
      ['REJECTED', [secondBooking.id]],
    ])
    for (const [search, expectedIds] of searches) {
      const result = await executeList(allContext, { search })
      assert.equal(result.bookings.totalCount, expectedIds.length)
      assert.deepEqual(
        new Set(result.bookings.items.map((booking) => booking.id)),
        new Set(expectedIds),
      )
    }
    for (const search of ['%', '_']) {
      const result = await executeList(allContext, { search })
      assert.equal(result.bookings.totalCount, 0)
    }

    const statusFiltered = await executeList(allContext, { status: 'REJECTED' })
    assert.equal(statusFiltered.bookings.totalCount, 1)
    assert.equal(statusFiltered.bookings.items[0]?.id, secondBooking.id)

    const dateFiltered = await executeList(allContext, {
      startDate: '2031-01-11T00:00:00.000Z',
      endDate: '2031-01-11T23:59:59.999Z',
    })
    assert.equal(dateFiltered.bookings.totalCount, 1)
    assert.equal(dateFiltered.bookings.items[0]?.id, secondBooking.id)

    const firstPage = await executeList(
      allContext,
      null,
      1,
      2,
      { field: 'startTime', direction: 'ASC' },
    )
    const secondPage = await executeList(
      allContext,
      null,
      2,
      2,
      { field: 'startTime', direction: 'ASC' },
    )
    assert.equal(firstPage.bookings.totalCount, 3)
    assert.deepEqual(firstPage.bookings.items.map((booking) => booking.id), [firstBooking.id, secondBooking.id])
    assert.deepEqual(secondPage.bookings.items.map((booking) => booking.id), [thirdBooking.id])

    const foreignResult = await graphql({
      schema,
      source: detailQuery,
      contextValue: ownContext,
      variableValues: { id: secondBooking.id },
    })
    const missingResult = await graphql({
      schema,
      source: detailQuery,
      contextValue: ownContext,
      variableValues: { id: randomUUID() },
    })
    const malformedResult = await graphql({
      schema,
      source: detailQuery,
      contextValue: ownContext,
      variableValues: { id: 'not-a-uuid' },
    })
    assert.deepEqual(responseSignature(foreignResult), responseSignature(missingResult))
    assert.deepEqual(responseSignature(foreignResult), responseSignature(malformedResult))
    assert.equal(JSON.stringify(foreignResult).includes(purpose), false)

    console.log('PASS booking:read:all sees multiple employees in one list call')
    console.log('PASS list nested requester, room, and equipment fields use request-scoped loaders')
    console.log('PASS booking:read:own list excludes another employee booking')
    console.log('PASS requester/room/equipment/purpose/status search with literal LIKE metacharacters')
    console.log('PASS status and start/end date filters')
    console.log('PASS pagination sorting and totalCount')
    console.log('SECURITY direct lookup responses')
    console.log(JSON.stringify({
      existsButNotOwned: responseSignature(foreignResult),
      doesNotExist: responseSignature(missingResult),
    }, null, 2))
  } finally {
    if (bookingIds.length > 0) {
      await bookingRepository.delete(bookingIds)
    }
    if (equipmentId !== null) {
      await equipmentRepository.delete(equipmentId)
    }
    if (roomId !== null) {
      await roomRepository.delete(roomId)
    }
    if (ownEmployeeId !== null) {
      await employeeRepository.delete(ownEmployeeId)
    }
    if (otherEmployeeId !== null) {
      await employeeRepository.delete(otherEmployeeId)
    }
    if (dataSource.isInitialized) {
      await dataSource.destroy()
    }
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
