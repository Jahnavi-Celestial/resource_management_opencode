import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { graphql, parse, printSchema, type ExecutionResult, type ObjectTypeDefinitionNode } from 'graphql'
import { buildSchema } from 'type-graphql'
import * as dataSourceModule from '../../../config/data-source'
import { authChecker } from '../../../auth/auth-checker'
import { formatError } from '../../../common/errors/format-error'
import { isUuid } from '../../../common/db/uuid'
import type { GraphQLContext } from '../../../common/graphql/context'
import { createLoaders } from '../../../loaders'
import { BookingService } from '../booking.service'
import { BookingResolver } from '../booking.resolver'
import type { CreateBookingInput } from '../booking.inputs'
import { Employee } from '../../employee/employee.entity'
import { MeetingRoom } from '../../room/room.entity'
import { Equipment } from '../../equipment/equipment.entity'
import { InputValidationError } from '../../../common/errors/field-errors'
import { DomainError } from '../../../common/errors/domain-error'
import { Booking } from '../booking.entity'
import type { TransactionalEntityManager } from '../../../common/db/transaction'

interface GqlError {
  message: string
  extensions?: Record<string, unknown>
}


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
      await dataSource.query(
        `DELETE FROM notification WHERE booking_id IN (SELECT id FROM booking WHERE room_id IN (${roomParams}))`,
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
      // The outbox is addressed, not linked to a booking, so clear the rows
      // addressed to the fixture employees before those employees are deleted.
      await dataSource.query(
        `DELETE FROM email_outbox WHERE to_email IN (SELECT email FROM employee WHERE id IN (${employeeParams}))`,
        employeeIds,
      )
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
      baseInput(equipmentRoomId, equipmentWindow, {
        equipment: [{ equipmentId: equipmentId.toUpperCase(), quantity: 2 }],
      }),
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

    // --- 11 room concurrency: N simultaneous createBooking calls for one slot ---
    const concEmployeeId = await createEmployee()
    const concRoom = await createRoom(1)
    const concWindow = futureWindow(48)
    const CONCURRENCY = 10
    const concInputs = Array.from({ length: CONCURRENCY }, () =>
      baseInput(concRoom, concWindow),
    )
    const beforeRoomConcCount = await count('booking')
    const concResults = await Promise.allSettled(
      concInputs.map((input) => service.createBooking(concEmployeeId, input)),
    )
    const concSuccesses = concResults.filter((r): r is PromiseFulfilledResult<Booking> => r.status === 'fulfilled')
    const concFailures = concResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    assert.equal(concSuccesses.length, 1, `Expected exactly 1 room-concurrency success, got ${concSuccesses.length}`)
    assert.equal(concFailures.length, CONCURRENCY - 1, `Expected ${CONCURRENCY - 1} room-concurrency failures, got ${concFailures.length}`)
    concFailures.forEach((f) => {
      assert.ok(f.reason instanceof DomainError, `Room-concurrency failure should be a DomainError, got ${f.reason?.constructor?.name}`)
      assert.match(f.reason.message, /room is not available/i)
    })
    const roomConcBookingCount = await count('booking')
    assert.equal(roomConcBookingCount - beforeRoomConcCount, 1, `Room concurrency: exactly 1 new booking row`)
    const roomConcBooking = concSuccesses[0]!.value
    assert.equal(roomConcBooking.status, 'PENDING')
    console.log(`PASS 11 room concurrency: ${CONCURRENCY} parallel calls → ${concSuccesses.length} success, ${concFailures.length} domain errors, 1 booking row`)

    // --- 12 equipment concurrency: N simultaneous calls for quantity=1 unit ---
    const eqConcEmployeeId = await createEmployee()
    const eqConcRoom = await createRoom(1)
    const eqConcEquipment = await createEquipment(1)
    const eqConcWindow = futureWindow(49)
    const eqConcInputs = Array.from({ length: CONCURRENCY }, () =>
      baseInput(eqConcRoom, eqConcWindow, {
        equipment: [{ equipmentId: eqConcEquipment, quantity: 1 }],
      }),
    )
    const beforeEqConcCount = await count('booking')
    const eqConcResults = await Promise.allSettled(
      eqConcInputs.map((input) => service.createBooking(eqConcEmployeeId, input)),
    )
    const eqSuccesses = eqConcResults.filter((r): r is PromiseFulfilledResult<Booking> => r.status === 'fulfilled')
    const eqFailures = eqConcResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    const [eqWinner] = eqSuccesses
    assert.equal(eqSuccesses.length, 1, `Expected exactly 1 equipment-concurrency success, got ${eqSuccesses.length}`)
    assert.equal(eqFailures.length, CONCURRENCY - 1, `Expected ${CONCURRENCY - 1} equipment-concurrency failures, got ${eqFailures.length}`)
    eqFailures.forEach((f) => {
      assert.ok(f.reason instanceof DomainError, `Equipment-concurrency failure should be a DomainError, got ${f.reason?.constructor?.name}`)
      assert.match(f.reason.message, /not available/i)
    })
    const eqConcBookingCount = await count('booking')
    assert.equal(eqConcBookingCount - beforeEqConcCount, 1, `Equipment concurrency: exactly 1 new booking row`)
    const eqConcEquipmentLines = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM booking_equipment WHERE booking_id = $1`,
      [(eqSuccesses[0] as PromiseFulfilledResult<Booking>).value.id],
    )
    assert.equal(Number(eqConcEquipmentLines[0].count), 1, `Equipment concurrency: winner has exactly 1 booking_equipment row`)
    console.log(`PASS 12 equipment concurrency: ${CONCURRENCY} parallel calls → ${eqSuccesses.length} success, ${eqFailures.length} domain errors, 1 winner, 1 booking_equipment row`)

    console.log('ALL BOOKING CREATE VALIDATION TESTS PASSED')

    // ================= S6 GRAPHQL LAYER: createBooking / cancelBooking resolver wiring =================
    // The service layer above is the S6 contract; these prove the two write
    // mutations are actually reachable over GraphQL and that cancelBooking
    // routes on the caller's identity and permissions (FR-37).
    const schema = await buildSchema({ resolvers: [BookingResolver], authChecker })

    const CREATE_BOOKING_MUTATION = `
      mutation CreateBooking($input: CreateBookingInput!) {
        createBooking(input: $input) {
          id status purpose roomId employeeId startTime endTime numberOfAttendees
        }
      }
    `
    const CANCEL_BOOKING_MUTATION = `
      mutation CancelBooking($id: ID!) {
        cancelBooking(id: $id) { id status }
      }
    `

    function firstError(result: ExecutionResult): GqlError {
      assert.ok(result.errors !== undefined && result.errors.length > 0, 'Expected a GraphQL error')
      const error = result.errors[0]!
      return formatError(error.toJSON(), error) as GqlError
    }

    function errorCode(result: ExecutionResult): string | undefined {
      return firstError(result).extensions?.code as string | undefined
    }

    async function gql(
      source: string,
      variableValues: Record<string, unknown>,
      contextValue: GraphQLContext,
    ): Promise<ExecutionResult> {
      return graphql({ schema, source, variableValues, contextValue })
    }

    function contextFor(employeeId: string, permissions: string[]): GraphQLContext {
      return {
        dataSource,
        auth: {
          employee: { id: employeeId },
          permissionKeys: new Set<string>(permissions),
        },
        loaders: createLoaders(dataSource),
      } as unknown as GraphQLContext
    }

    async function auditRowsFor(bookingId: string): Promise<Array<{ action: string; old_status: string | null; new_status: string; performed_by: string | null }>> {
      return (await dataSource.query(
        'SELECT action, old_status, new_status, performed_by FROM audit_log WHERE booking_id = $1 ORDER BY created_at ASC',
        [bookingId],
      )) as Array<{ action: string; old_status: string | null; new_status: string; performed_by: string | null }>
    }

    // Seeded role permission sets, mirroring database/seeds/roles.seed.ts.
    const EMPLOYEE_PERMISSIONS = ['booking:create', 'booking:read:own', 'booking:cancel:own']
    const MANAGER_PERMISSIONS = ['booking:read:all', 'booking:approve', 'booking:reject', 'booking:cancel:any']

    const gqlOwnerId = await createEmployee()
    const gqlManagerId = await createEmployee()
    const gqlStrangerId = await createEmployee()
    const gqlRoomId = await createRoom(4)
    const ownerContext = contextFor(gqlOwnerId, EMPLOYEE_PERMISSIONS)
    const managerContext = contextFor(gqlManagerId, MANAGER_PERMISSIONS)
    const strangerContext = contextFor(gqlStrangerId, EMPLOYEE_PERMISSIONS)
    const anonymous = { dataSource, auth: null, loaders: createLoaders(dataSource) } as unknown as GraphQLContext

    let gqlOffset = 96
    function gqlWindow(): { startTime: Date; endTime: Date } {
      const startTime = new Date(Date.now() + gqlOffset * 60 * 60 * 1000)
      gqlOffset += 1
      return { startTime, endTime: new Date(startTime.getTime() + 60 * 60 * 1000) }
    }

    // --- SCENARIO 13: createBooking over GraphQL returns a PENDING booking with its UUID (FR-36/38) ---
    const createWindow = gqlWindow()
    const createInput = {
      roomId: gqlRoomId,
      startTime: createWindow.startTime.toISOString(),
      endTime: createWindow.endTime.toISOString(),
      purpose: 'GraphQL layer booking',
      numberOfAttendees: 2,
    }

    const createAnonymous = await gql(CREATE_BOOKING_MUTATION, { input: createInput }, anonymous)
    assert.equal(errorCode(createAnonymous), 'FORBIDDEN', 'Unauthenticated createBooking must be FORBIDDEN')
    assert.equal(firstError(createAnonymous).message, 'Not authorised')
    console.log(`PASS 13a createBooking without a token → ${errorCode(createAnonymous)} "${firstError(createAnonymous).message}"`)

    const createNoPermission = await gql(
      CREATE_BOOKING_MUTATION,
      { input: createInput },
      contextFor(gqlStrangerId, ['booking:read:own', 'booking:cancel:own']),
    )
    assert.equal(errorCode(createNoPermission), 'FORBIDDEN', 'createBooking without booking:create must be FORBIDDEN')
    assert.equal(
      firstError(createNoPermission).message,
      'Not authorised',
      'Authz failure must stay generic and must not name the missing permission',
    )
    console.log(`PASS 13b createBooking as employee lacking booking:create → ${errorCode(createNoPermission)} "${firstError(createNoPermission).message}"`)

    const created = await gql(CREATE_BOOKING_MUTATION, { input: createInput }, ownerContext)
    assert.equal(created.errors, undefined, `createBooking failed: ${JSON.stringify(created.errors?.map((e) => e.message))}`)
    const createdData = created.data as {
      createBooking: {
        id: string
        status: string
        purpose: string
        roomId: string
        employeeId: string
        numberOfAttendees: number
      }
    }
    assert.ok(isUuid(createdData.createBooking.id), `FR-38: the returned reference must be a UUID, got ${createdData.createBooking.id}`)
    assert.equal(createdData.createBooking.status, 'PENDING', 'A new booking must be created PENDING (FR-36)')
    assert.equal(createdData.createBooking.employeeId, gqlOwnerId, 'The booking must be attributed to the caller, never to a client-supplied id')
    assert.equal(createdData.createBooking.roomId, gqlRoomId)
    assert.equal(createdData.createBooking.purpose, 'GraphQL layer booking')
    assert.equal(createdData.createBooking.numberOfAttendees, 2)
    const persistedCreate = await dataSource.getRepository(Booking).findOneByOrFail({ id: createdData.createBooking.id })
    assert.equal(persistedCreate.status, 'PENDING')
    const createAudits = await auditRowsFor(createdData.createBooking.id)
    assert.equal(createAudits.length, 1, 'createBooking must write exactly one audit row')
    assert.equal(createAudits[0]!.action, 'CREATE')
    assert.equal(createAudits[0]!.new_status, 'PENDING')
    assert.equal(createAudits[0]!.performed_by, gqlOwnerId, 'The audit actor must be the authenticated caller')
    console.log(`PASS 13c createBooking → ${createdData.createBooking.id} status=${createdData.createBooking.status} attendees=${createdData.createBooking.numberOfAttendees} audit=CREATE by caller`)

    const createBadRoom = await gql(
      CREATE_BOOKING_MUTATION,
      { input: { ...createInput, roomId: randomUUID() } },
      ownerContext,
    )
    assert.equal(errorCode(createBadRoom), 'NOT_FOUND', 'An unknown room must be NOT_FOUND')
    console.log(`PASS 13d createBooking with unknown room → ${errorCode(createBadRoom)} "${firstError(createBadRoom).message}"`)

    // --- SCENARIO 14: the requester cancels their own PENDING booking (own path, FR-37) ---
    const ownCancelled = await gql(CANCEL_BOOKING_MUTATION, { id: createdData.createBooking.id }, ownerContext)
    assert.equal(ownCancelled.errors, undefined, `Own cancel failed: ${JSON.stringify(ownCancelled.errors?.map((e) => e.message))}`)
    const ownData = ownCancelled.data as { cancelBooking: { id: string; status: string } }
    assert.equal(ownData.cancelBooking.status, 'CANCELLED', 'The requester cancelling their own PENDING booking must succeed')
    const ownAudits = await auditRowsFor(createdData.createBooking.id)
    const ownCancelAudit = ownAudits.find((row) => row.action === 'CANCEL')
    assert.ok(ownCancelAudit !== undefined, 'A CANCEL audit row must exist')
    assert.equal(ownCancelAudit!.old_status, 'PENDING')
    assert.equal(ownCancelAudit!.new_status, 'CANCELLED')
    assert.equal(ownCancelAudit!.performed_by, gqlOwnerId, 'The audit actor must be the requester who cancelled')
    console.log(`PASS 14a requester cancels own PENDING booking → ${ownData.cancelBooking.status}, audit=CANCEL by requester`)

    // FR-37 is PENDING-only for the owner: an approved booking is the manager's
    // to cancel, so the owner is refused rather than silently allowed.
    const ownerApprovedWindow = gqlWindow()
    const ownerApprovedRaw = await gql(
      CREATE_BOOKING_MUTATION,
      {
        input: {
          roomId: gqlRoomId,
          startTime: ownerApprovedWindow.startTime.toISOString(),
          endTime: ownerApprovedWindow.endTime.toISOString(),
          purpose: 'Owner approved booking',
          numberOfAttendees: 1,
        },
      },
      ownerContext,
    )
    assert.equal(ownerApprovedRaw.errors, undefined)
    const ownerApprovedId = (ownerApprovedRaw.data as { createBooking: { id: string } }).createBooking.id
    await service.approveBooking(gqlManagerId, ownerApprovedId)
    const ownerCancelsApproved = await gql(CANCEL_BOOKING_MUTATION, { id: ownerApprovedId }, ownerContext)
    assert.equal(
      errorCode(ownerCancelsApproved),
      'BAD_USER_INPUT',
      'The owner must not cancel their own APPROVED booking',
    )
    assert.match(firstError(ownerCancelsApproved).message, /cannot be cancelled from its current status: APPROVED/)
    assert.equal(
      (await dataSource.getRepository(Booking).findOneByOrFail({ id: ownerApprovedId })).status,
      'APPROVED',
      'A refused own-cancel must leave the booking APPROVED',
    )
    console.log(`PASS 14b requester cancels own APPROVED booking → ${errorCode(ownerCancelsApproved)} "${firstError(ownerCancelsApproved).message}" (stays APPROVED)`)

    // --- SCENARIO 15: a manager cancels someone else's booking (any path) ---
    const managerTargetWindow = gqlWindow()
    const managerTargetRaw = await gql(
      CREATE_BOOKING_MUTATION,
      {
        input: {
          roomId: gqlRoomId,
          startTime: managerTargetWindow.startTime.toISOString(),
          endTime: managerTargetWindow.endTime.toISOString(),
          purpose: 'Manager cancellation target',
          numberOfAttendees: 1,
        },
      },
      ownerContext,
    )
    assert.equal(managerTargetRaw.errors, undefined)
    const managerTargetId = (managerTargetRaw.data as { createBooking: { id: string } }).createBooking.id

    const managerCancelsPending = await gql(CANCEL_BOOKING_MUTATION, { id: managerTargetId }, managerContext)
    assert.equal(managerCancelsPending.errors, undefined, `Manager cancel failed: ${JSON.stringify(managerCancelsPending.errors?.map((e) => e.message))}`)
    const managerPendingData = managerCancelsPending.data as { cancelBooking: { id: string; status: string } }
    assert.equal(managerPendingData.cancelBooking.status, 'CANCELLED', 'A manager must be able to cancel another user PENDING booking')
    const managerPendingAudit = (await auditRowsFor(managerTargetId)).find((row) => row.action === 'CANCEL')
    assert.equal(managerPendingAudit?.performed_by, gqlManagerId, 'The audit actor must be the cancelling manager')
    console.log(`PASS 15a manager cancels another user PENDING booking → ${managerPendingData.cancelBooking.status}, audit=CANCEL by manager`)

    const managerApprovedWindow = gqlWindow()
    const managerApprovedRaw = await gql(
      CREATE_BOOKING_MUTATION,
      {
        input: {
          roomId: gqlRoomId,
          startTime: managerApprovedWindow.startTime.toISOString(),
          endTime: managerApprovedWindow.endTime.toISOString(),
          purpose: 'Manager approved cancellation target',
          numberOfAttendees: 1,
        },
      },
      ownerContext,
    )
    assert.equal(managerApprovedRaw.errors, undefined)
    const managerApprovedId = (managerApprovedRaw.data as { createBooking: { id: string } }).createBooking.id
    await service.approveBooking(gqlManagerId, managerApprovedId)
    const managerCancelsApproved = await gql(CANCEL_BOOKING_MUTATION, { id: managerApprovedId }, managerContext)
    assert.equal(
      managerCancelsApproved.errors,
      undefined,
      `Manager cancel of APPROVED failed: ${JSON.stringify(managerCancelsApproved.errors?.map((e) => e.message))}`,
    )
    assert.equal(
      (managerCancelsApproved.data as { cancelBooking: { status: string } }).cancelBooking.status,
      'CANCELLED',
      'The any-cancel path must also cover an APPROVED booking',
    )
    console.log('PASS 15b manager cancels another user APPROVED booking → CANCELLED (any path covers PENDING and APPROVED)')

    // --- SCENARIO 15c: a cancellation enqueues no outbox row (FR-61) ---
    //
    // "Zero rows" on its own cannot tell a deliberate decision apart from a
    // broken pipeline — a test that only counted rows would have passed against
    // the old template ternary, which suppressed the cancellation mail as a side
    // effect of the unrelated missing-reason guard. So this scenario carries its
    // own positive control: the same notifyRequesterOfDecision → enqueueDecisionEmail
    // path, handed a rejection that has its reason, must produce exactly one
    // BOOKING_REJECTED row for the same requester. Only once that lands does the
    // cancel's zero mean "FR-61 does not cover cancellations" rather than
    // "the email pipeline is dead".
    const requesterEmail = (await dataSource.getRepository(Employee).findOneByOrFail({ id: gqlOwnerId })).email
    const outboxForRequester = async (): Promise<
      Array<{ id: string; event_type: string; subject: string; status: string }>
    > =>
      (await dataSource.query(
        'SELECT id, event_type, subject, status FROM email_outbox WHERE to_email = $1 ORDER BY created_at ASC',
        [requesterEmail],
      )) as Array<{ id: string; event_type: string; subject: string; status: string }>
    const notificationsFor = async (
      bookingId: string,
    ): Promise<Array<{ recipient_id: string; type: string }>> =>
      (await dataSource.query('SELECT recipient_id, type FROM notification WHERE booking_id = $1', [bookingId])) as Array<{
        recipient_id: string
        type: string
      }>

    // Earlier scenarios in this suite share the requester and legitimately sent
    // approval mail, so the baseline is a set of row ids rather than a count of
    // zero, and every assertion below is about rows this scenario adds.
    const outboxBaselineIds = new Set((await outboxForRequester()).map((row) => row.id))

    // The cancellation under test. A manager cancelling someone else's booking
    // is the only path that both notifies the requester and could plausibly be
    // mistaken for a decision, so it is the one worth pinning.
    const cancelledPurpose = 'Cancellation must not send mail'
    const cancelMailWindow = gqlWindow()
    const cancelMailTarget = await gql(
      CREATE_BOOKING_MUTATION,
      {
        input: {
          roomId: gqlRoomId,
          startTime: cancelMailWindow.startTime.toISOString(),
          endTime: cancelMailWindow.endTime.toISOString(),
          purpose: cancelledPurpose,
          numberOfAttendees: 1,
        },
      },
      ownerContext,
    )
    assert.equal(cancelMailTarget.errors, undefined)
    const cancelMailId = (cancelMailTarget.data as { createBooking: { id: string } }).createBooking.id

    const cancelMailCancel = await gql(CANCEL_BOOKING_MUTATION, { id: cancelMailId }, managerContext)
    assert.equal(
      cancelMailCancel.errors,
      undefined,
      `Manager cancel for the mail assertion failed: ${JSON.stringify(cancelMailCancel.errors?.map((e) => e.message))}`,
    )
    assert.equal(
      (cancelMailCancel.data as { cancelBooking: { status: string } }).cancelBooking.status,
      'CANCELLED',
    )

    // The decision path really did run — it notified the requester (FR-57)...
    const cancelNotifications = await notificationsFor(cancelMailId)
    assert.ok(
      cancelNotifications.some((row) => row.recipient_id === gqlOwnerId && row.type === 'BOOKING_CANCELLED'),
      `The requester must be notified of the cancellation; got ${JSON.stringify(cancelNotifications)}`,
    )
    // ...and it still enqueued no mail, because FR-61 covers approval, rejection
    // and reminder only.
    const outboxAfterCancel = await outboxForRequester()
    const addedByCancel = outboxAfterCancel.filter((row) => !outboxBaselineIds.has(row.id))
    assert.deepEqual(
      addedByCancel.map((row) => row.subject),
      [],
      'FR-61: a cancellation must enqueue no outbox row',
    )
    assert.equal(
      outboxAfterCancel.filter((row) => row.subject.includes(cancelledPurpose)).length,
      0,
      'No outbox row may be rendered from the cancelled booking — in particular none with a "was rejected" subject',
    )

    // Positive control, same requester, same helper, one call later.
    const controlPurpose = 'Control rejection must send mail'
    const controlWindow = gqlWindow()
    const controlTarget = await gql(
      CREATE_BOOKING_MUTATION,
      {
        input: {
          roomId: gqlRoomId,
          startTime: controlWindow.startTime.toISOString(),
          endTime: controlWindow.endTime.toISOString(),
          purpose: controlPurpose,
          numberOfAttendees: 1,
        },
      },
      ownerContext,
    )
    assert.equal(controlTarget.errors, undefined)
    const controlId = (controlTarget.data as { createBooking: { id: string } }).createBooking.id
    await service.rejectBooking(gqlManagerId, controlId, 'Control reason: the room is double-booked')

    const outboxAfterControl = await outboxForRequester()
    const addedByControl = outboxAfterControl.filter((row) => !outboxBaselineIds.has(row.id))
    assert.equal(
      addedByControl.length,
      1,
      'The control: a rejection carrying a reason must enqueue exactly one outbox row, so the cancellation zero is a decision and not a dead pipeline',
    )
    const controlRow = addedByControl.find((row) => row.subject.includes(controlPurpose))
    assert.ok(controlRow, `The control row must be addressed to the requester; got ${JSON.stringify(addedByControl)}`)
    assert.equal(controlRow?.event_type, 'BOOKING_REJECTED')
    assert.match(controlRow?.subject ?? '', /was rejected/)
    assert.equal(
      outboxAfterControl.filter((row) => row.subject.includes(cancelledPurpose)).length,
      0,
      'A later decision produced mail without retroactively producing any for the cancelled booking',
    )
    console.log(
      `PASS 15c cancellation enqueues no outbox row (FR-61: approval/rejection/reminder only) while a rejection with a reason enqueues exactly one → ${addedByControl.length} new row(s) for the requester, 0 from the cancelled booking`,
    )

    // --- SCENARIO 15d: the reason-bearing cancellation, the case 15c cannot see ---
    //
    // 15c above still passes against the old `type === 'BOOKING_APPROVED' ? ... : 'BOOKING_REJECTED'`
    // ternary, because a cancellation carries no reason and the missing-reason
    // guard suppressed the wrong mail for its own unrelated reason. So the
    // discriminating case is a BOOKING_CANCELLED decision that *does* carry a
    // reason: that disarms the guard, leaving the template mapping as the only
    // thing that can stop the mail. Old code queues a "Your booking ... was
    // rejected" email here; the mapping queues nothing.
    //
    // The public cancel API takes no reason, so this reaches the private
    // decision helper deliberately — a white-box test of exactly the latent
    // case, and the reason `DECISION_EMAIL_TEMPLATE` is a table rather than a
    // ternary.
    const latentWindow = gqlWindow()
    const latentRaw = await gql(
      CREATE_BOOKING_MUTATION,
      {
        input: {
          roomId: gqlRoomId,
          startTime: latentWindow.startTime.toISOString(),
          endTime: latentWindow.endTime.toISOString(),
          purpose: 'Cancellation that carries a reason',
          numberOfAttendees: 1,
        },
      },
      ownerContext,
    )
    assert.equal(latentRaw.errors, undefined)
    const latentId = (latentRaw.data as { createBooking: { id: string } }).createBooking.id
    const latentBooking = await dataSource.getRepository(Booking).findOneByOrFail({ id: latentId })

    const postCommit: Array<() => Promise<void> | void> = []
    const collectingTx = {
      afterCommit: (callback: () => Promise<void> | void): void => {
        postCommit.push(callback)
      },
    } as unknown as TransactionalEntityManager

    const outboxBeforeLatent = new Set((await outboxForRequester()).map((row) => row.id))
    const notifyRequesterOfDecision = (
      service as unknown as {
        notifyRequesterOfDecision(
          tx: TransactionalEntityManager,
          requesterId: string | null,
          actorId: string,
          type: 'BOOKING_APPROVED' | 'BOOKING_REJECTED' | 'BOOKING_CANCELLED',
          booking: Booking,
          reason?: string,
        ): void
      }
    ).notifyRequesterOfDecision.bind(service)

    notifyRequesterOfDecision(
      collectingTx,
      gqlOwnerId,
      gqlManagerId,
      'BOOKING_CANCELLED',
      latentBooking,
      'A reason that must not turn into a rejection email',
    )
    assert.ok(
      postCommit.length >= 1,
      'A cancellation still registers its notification write post-commit (FR-57)',
    )
    for (const callback of postCommit) {
      await callback()
    }

    const latentOutbox = (await outboxForRequester()).filter((row) => !outboxBeforeLatent.has(row.id))
    assert.deepEqual(
      latentOutbox.map((row) => row.subject),
      [],
      'A BOOKING_CANCELLED decision carrying a reason must still enqueue no outbox row — the mapping, not the missing-reason guard, is what stops it',
    )
    const latentNotifications = await notificationsFor(latentId)
    assert.ok(
      latentNotifications.some((row) => row.recipient_id === gqlOwnerId && row.type === 'BOOKING_CANCELLED'),
      'and the requester is still notified, so the decision path genuinely ran',
    )
    console.log(
      'PASS 15d BOOKING_CANCELLED with a reason still enqueues no outbox row (guard disarmed → the template mapping is what suppresses it)',
    )

    // --- SCENARIO 16: a caller who is neither owner nor cancel:any is refused ---
    const strangerTargetWindow = gqlWindow()
    const strangerTargetRaw = await gql(
      CREATE_BOOKING_MUTATION,
      {
        input: {
          roomId: gqlRoomId,
          startTime: strangerTargetWindow.startTime.toISOString(),
          endTime: strangerTargetWindow.endTime.toISOString(),
          purpose: 'Stranger cancellation target',
          numberOfAttendees: 1,
        },
      },
      ownerContext,
    )
    assert.equal(strangerTargetRaw.errors, undefined)
    const strangerTargetId = (strangerTargetRaw.data as { createBooking: { id: string } }).createBooking.id

    const strangerCancel = await gql(CANCEL_BOOKING_MUTATION, { id: strangerTargetId }, strangerContext)
    assert.equal(errorCode(strangerCancel), 'FORBIDDEN', 'A non-owner without booking:cancel:any must be FORBIDDEN')
    assert.equal(
      firstError(strangerCancel).message,
      'Not authorised',
      'A refused cancel must not disclose whether the booking exists',
    )
    assert.equal(
      (await dataSource.getRepository(Booking).findOneByOrFail({ id: strangerTargetId })).status,
      'PENDING',
      'A refused cancel must leave the booking PENDING',
    )
    const strangerAudits = await auditRowsFor(strangerTargetId)
    assert.equal(strangerAudits.filter((row) => row.action === 'CANCEL').length, 0, 'A refused cancel must not write an audit row')
    console.log(`PASS 16a non-owner without booking:cancel:any → ${errorCode(strangerCancel)} "${firstError(strangerCancel).message}" (booking stays PENDING, no audit row)`)

    // --- SCENARIO 17: the routing rules themselves ---
    const cancelAnonymous = await gql(CANCEL_BOOKING_MUTATION, { id: strangerTargetId }, anonymous)
    assert.equal(errorCode(cancelAnonymous), 'FORBIDDEN', 'Unauthenticated cancelBooking must be FORBIDDEN')
    console.log(`PASS 17a cancelBooking without a token → ${errorCode(cancelAnonymous)} "${firstError(cancelAnonymous).message}"`)

    const noCancelPermission = await gql(
      CANCEL_BOOKING_MUTATION,
      { id: strangerTargetId },
      contextFor(gqlStrangerId, ['booking:read:own', 'booking:create']),
    )
    assert.equal(
      errorCode(noCancelPermission),
      'FORBIDDEN',
      'A caller holding neither cancel permission must be refused before the booking is looked up',
    )
    console.log(`PASS 17b caller with neither booking:cancel:own nor :any → ${errorCode(noCancelPermission)} "${firstError(noCancelPermission).message}"`)

    // A manager who somehow owns the booking has cancel:any but not
    // cancel:own, and the own path is the only one that applies to a requester,
    // so the request is refused rather than escalated through the any path.
    const ownerHoldsOnlyAnyContext = contextFor(gqlOwnerId, ['booking:create', 'booking:cancel:any'])
    const ownerOnlyAny = await gql(CANCEL_BOOKING_MUTATION, { id: strangerTargetId }, ownerHoldsOnlyAnyContext)
    assert.equal(
      errorCode(ownerOnlyAny),
      'FORBIDDEN',
      'The requester path requires booking:cancel:own even when the caller also holds booking:cancel:any',
    )
    assert.equal(
      (await dataSource.getRepository(Booking).findOneByOrFail({ id: strangerTargetId })).status,
      'PENDING',
      'A refused own-path cancel must leave the booking PENDING',
    )
    console.log(`PASS 17c requester holding only booking:cancel:any → ${errorCode(ownerOnlyAny)} "${firstError(ownerOnlyAny).message}" (own path needs :own)`)

    const unknownBooking = await gql(CANCEL_BOOKING_MUTATION, { id: randomUUID() }, managerContext)
    assert.equal(errorCode(unknownBooking), 'NOT_FOUND', 'A manager cancelling an unknown id must be NOT_FOUND')
    console.log(`PASS 17d cancelBooking on an unknown id as cancel:any holder → ${errorCode(unknownBooking)} "${firstError(unknownBooking).message}"`)

    const strangerUnknownBooking = await gql(CANCEL_BOOKING_MUTATION, { id: randomUUID() }, strangerContext)
    assert.equal(
      errorCode(strangerUnknownBooking),
      'NOT_FOUND',
      'A cancel:own-only caller asking about an id they do not own reaches the lookup and is told it does not exist',
    )
    console.log(`PASS 17e cancel:own-only caller on a foreign id → ${errorCode(strangerUnknownBooking)} (no booking, no disclosure)`)

    const ownerCancelsAgain = await gql(CANCEL_BOOKING_MUTATION, { id: createdData.createBooking.id }, ownerContext)
    assert.equal(errorCode(ownerCancelsAgain), 'BAD_USER_INPUT', 'Cancelling an already CANCELLED booking must be refused')
    assert.match(firstError(ownerCancelsAgain).message, /cannot be cancelled from its current status: CANCELLED/)
    console.log(`PASS 17f re-cancelling a CANCELLED booking → ${errorCode(ownerCancelsAgain)} "${firstError(ownerCancelsAgain).message}"`)

    const mutationNames = parse(printSchema(schema)).definitions
      .filter(
        (definition): definition is ObjectTypeDefinitionNode =>
          definition.kind === 'ObjectTypeDefinition' && definition.name.value === 'Mutation',
      )
      .flatMap((definition) => (definition.fields ?? []).map((field) => field.name.value))
    assert.ok(mutationNames.includes('createBooking'), `createBooking must be exposed as a mutation, found: ${mutationNames.join(', ')}`)
    assert.ok(mutationNames.includes('cancelBooking'), `cancelBooking must be exposed as a mutation, found: ${mutationNames.join(', ')}`)
    console.log(`PASS 17g emitted schema exposes both write mutations: createBooking, cancelBooking (of ${mutationNames.length} mutations)`)

    console.log('ALL BOOKING WRITE MUTATION GRAPHQL TESTS PASSED')
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
