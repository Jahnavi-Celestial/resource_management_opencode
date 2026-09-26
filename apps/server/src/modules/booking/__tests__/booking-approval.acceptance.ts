import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { graphql, type ExecutionResult } from 'graphql'
import { buildSchema } from 'type-graphql'
import { authChecker } from '../../../auth/auth-checker'
import { createDataSource } from '../../../config/data-source'
import { formatError } from '../../../common/errors/format-error'
import { InputValidationError } from '../../../common/errors/field-errors'
import type { GraphQLContext } from '../../../common/graphql/context'
import { createLoaders } from '../../../loaders'
import { BookingService } from '../booking.service'
import { BookingResolver } from '../booking.resolver'
import { Booking } from '../booking.entity'
import { BookingEquipment } from '../booking-equipment.entity'
import { Employee } from '../../employee/employee.entity'
import { Equipment } from '../../equipment/equipment.entity'
import { MeetingRoom } from '../../room/room.entity'
import { loadEnv } from '../../../config/env'

interface GqlError {
  message: string
  extensions?: Record<string, unknown>
}

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

    // --- SCENARIO 8: A manager cannot decide on a booking they created themselves (FR-56) ---
    await resetData()
    const selfManagerId = await createEmployee('Approval', 'SelfManager', 'selfmgr')
    const selfRoomId = await createRoom(10)
    const selfBooking = await createPendingBooking(selfManagerId, selfRoomId, 60)
    const selfRejectionTarget = await createPendingBooking(selfManagerId, selfRoomId, 61)
    await assertReject('8a self-approval', () => service.approveBooking(selfManagerId, selfBooking.id), /A manager cannot approve or reject their own booking request/)
    assert.equal(
      (await dataSource.getRepository(Booking).findOneByOrFail({ id: selfBooking.id })).status,
      'PENDING',
      'Refused self-approval must leave the booking PENDING',
    )
    assert.equal(
      (await getAudits(selfBooking.id)).length,
      0,
      'Refused self-approval must not write an audit row',
    )
    console.log('PASS 8a manager approving own booking refused, stays PENDING, no audit')

    // --- SCENARIO 9: Self-rejection is refused the same way ---
    await assertReject('9a self-rejection', () => service.rejectBooking(selfManagerId, selfRejectionTarget.id, validReason), /A manager cannot approve or reject their own booking request/)
    assert.equal(
      (await dataSource.getRepository(Booking).findOneByOrFail({ id: selfRejectionTarget.id })).status,
      'PENDING',
      'Refused self-rejection must leave the booking PENDING',
    )
    assert.equal(
      (await dataSource.getRepository(Booking).findOneByOrFail({ id: selfRejectionTarget.id })).rejectionReason,
      null,
      'Refused self-rejection must not persist a reason',
    )
    assert.equal(
      (await getAudits(selfRejectionTarget.id)).length,
      0,
      'Refused self-rejection must not write an audit row',
    )
    console.log('PASS 9a manager rejecting own booking refused, stays PENDING, no reason, no audit')

    // --- SCENARIO 10: A different manager decides the very same bookings normally ---
    const approvedByOther = await service.approveBooking(managerId, selfBooking.id)
    assert.equal(approvedByOther.status, 'APPROVED', 'Another manager must be able to approve the booking')
    const selfAuditAfterOtherApproval = await getAudits(selfBooking.id)
    assert.equal(selfAuditAfterOtherApproval.length, 1, 'Exactly one audit row after the other manager approves')
    assert.equal(selfAuditAfterOtherApproval[0]!.action, 'APPROVE')
    assert.equal(selfAuditAfterOtherApproval[0]!.performed_by, managerId)
    console.log(`PASS 10a different manager approves creator's booking: ${selfBooking.id} → APPROVED, audit by other manager`)

    const rejectedByOther = await service.rejectBooking(managerId, selfRejectionTarget.id, validReason)
    assert.equal(rejectedByOther.status, 'REJECTED', 'Another manager must be able to reject the booking')
    assert.equal(rejectedByOther.rejectionReason, validReason, 'Reason persisted by the other manager')
    const selfAuditAfterOtherRejection = await getAudits(selfRejectionTarget.id)
    assert.equal(selfAuditAfterOtherRejection.length, 1, 'Exactly one audit row after the other manager rejects')
    assert.equal(selfAuditAfterOtherRejection[0]!.action, 'REJECT')
    assert.equal(selfAuditAfterOtherRejection[0]!.performed_by, managerId)
    console.log(`PASS 10b different manager rejects creator's booking: ${selfRejectionTarget.id} → REJECTED, reason + audit correct`)

    // ================= S8 GRAPHQL LAYER: resolver wiring =================
    const schema = await buildSchema({ resolvers: [BookingResolver], authChecker })

    const PENDING_QUEUE_QUERY = `
      query PendingQueue($page: Int!, $pageSize: Int!) {
        pendingQueue(page: $page, pageSize: $pageSize) {
          totalCount
          items { id status createdAt }
        }
      }
    `
    const APPROVE_MUTATION = `
      mutation ApproveBooking($id: ID!) {
        approveBooking(id: $id) { id status processedAt }
      }
    `
    const REJECT_MUTATION = `
      mutation RejectBooking($input: RejectBookingInput!) {
        rejectBooking(input: $input) { id status rejectionReason }
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

    function contextFor(employee: Employee, permissions: string[]): GraphQLContext {
      return {
        dataSource,
        auth: { employee, permissionKeys: new Set<string>(permissions) },
        loaders: createLoaders(dataSource),
      } as unknown as GraphQLContext
    }

    async function loadEmployee(id: string): Promise<Employee> {
      return dataSource.getRepository(Employee).findOneByOrFail({ id })
    }

    // --- SCENARIO 11: pendingQueue is gated by booking:approve (FR-50) ---
    await resetData()
    const gqlManagerId = await createEmployee('Approval', 'Gqlmanager', 'gqlmgr')
    const gqlPeerId = await createEmployee('Approval', 'Gqlpeer', 'gqlpeer')
    const requesterId = await createEmployee('Approval', 'Requester', 'gqlreq')
    const gqlRoomId = await createRoom(10)
    const gqlManager = await loadEmployee(gqlManagerId)
    const requester = await loadEmployee(requesterId)

    const bothPermissions = contextFor(gqlManager, ['booking:approve', 'booking:reject'])
    const readOnly = contextFor(requester, ['booking:read:own', 'booking:create'])
    const approveOnly = contextFor(gqlManager, ['booking:approve'])
    const rejectOnly = contextFor(gqlManager, ['booking:reject'])
    const anonymous = { dataSource, auth: null, loaders: createLoaders(dataSource) } as unknown as GraphQLContext

    const queueAnonymous = await gql(PENDING_QUEUE_QUERY, { page: 1, pageSize: 10 }, anonymous)
    assert.equal(errorCode(queueAnonymous), 'FORBIDDEN', 'Unauthenticated pendingQueue must be FORBIDDEN')
    assert.equal(firstError(queueAnonymous).message, 'Not authorised')
    console.log(`PASS 11a pendingQueue without a token → ${errorCode(queueAnonymous)} "${firstError(queueAnonymous).message}"`)

    const queueWrongPermission = await gql(PENDING_QUEUE_QUERY, { page: 1, pageSize: 10 }, readOnly)
    assert.equal(errorCode(queueWrongPermission), 'FORBIDDEN', 'pendingQueue without booking:approve must be FORBIDDEN')
    assert.equal(
      firstError(queueWrongPermission).message,
      'Not authorised',
      'Authz failure must stay generic and must not name the missing permission',
    )
    console.log(`PASS 11b pendingQueue as employee lacking booking:approve → ${errorCode(queueWrongPermission)} "${firstError(queueWrongPermission).message}"`)

    // --- SCENARIO 12: no caller-supplied sort argument; order forced to createdAt ASC ---
    const sortAttempt = await graphql({
      schema,
      source: 'query { pendingQueue(page: 1, pageSize: 10, sort: { field: "createdAt", direction: DESC }) { totalCount } }',
      contextValue: bothPermissions,
    })
    assert.ok(
      (sortAttempt.errors ?? []).some((error) => /sort/.test(error.message)),
      `pendingQueue must reject a caller-supplied sort argument, got: ${JSON.stringify(sortAttempt.errors?.map((e) => e.message))}`,
    )
    console.log(`PASS 12a pendingQueue exposes no sort argument: "${sortAttempt.errors?.[0]?.message ?? ''}"`)

    const firstQueued = await createPendingBooking(requesterId, gqlRoomId, 70)
    const secondQueued = await createPendingBooking(requesterId, gqlRoomId, 71)
    const gqlQueue = await gql(PENDING_QUEUE_QUERY, { page: 1, pageSize: 10 }, bothPermissions)
    assert.equal(gqlQueue.errors, undefined, `pendingQueue failed: ${JSON.stringify(gqlQueue.errors?.map((e) => e.message))}`)
    const queueData = gqlQueue.data as { pendingQueue: { totalCount: number; items: Array<{ id: string; createdAt: string }> } }
    assert.equal(queueData.pendingQueue.totalCount, 2, 'Queue must contain both PENDING fixture bookings')
    assert.deepEqual(
      queueData.pendingQueue.items.map((item) => item.id),
      [firstQueued.id, secondQueued.id],
      'Queue must be ordered by createdAt ASC',
    )
    console.log(`PASS 12b pendingQueue returns ${queueData.pendingQueue.totalCount} items ordered createdAt ASC: ${firstQueued.id} → ${secondQueued.id}`)

    // --- SCENARIO 13: approveBooking is gated by booking:approve (FR-51) ---
    const approveAnonymous = await gql(APPROVE_MUTATION, { id: firstQueued.id }, anonymous)
    assert.equal(errorCode(approveAnonymous), 'FORBIDDEN', 'Unauthenticated approveBooking must be FORBIDDEN')
    console.log(`PASS 13a approveBooking without a token → ${errorCode(approveAnonymous)}`)

    const approveWrongPermission = await gql(APPROVE_MUTATION, { id: firstQueued.id }, readOnly)
    assert.equal(errorCode(approveWrongPermission), 'FORBIDDEN', 'approveBooking without booking:approve must be FORBIDDEN')
    assert.equal(firstError(approveWrongPermission).message, 'Not authorised')
    assert.equal(
      (await dataSource.getRepository(Booking).findOneByOrFail({ id: firstQueued.id })).status,
      'PENDING',
      'Forbidden approve must not change status',
    )
    console.log(`PASS 13b approveBooking as employee lacking booking:approve → ${errorCode(approveWrongPermission)} "${firstError(approveWrongPermission).message}", booking stays PENDING`)

    const approveOk = await gql(APPROVE_MUTATION, { id: firstQueued.id }, bothPermissions)
    assert.equal(approveOk.errors, undefined, `approveBooking failed: ${JSON.stringify(approveOk.errors?.map((e) => e.message))}`)
    const approveData = approveOk.data as { approveBooking: { id: string; status: string; processedAt: string | null } }
    assert.equal(approveData.approveBooking.status, 'APPROVED')
    assert.equal(approveData.approveBooking.id, firstQueued.id)
    assert.notEqual(approveData.approveBooking.processedAt, null, 'processedAt must resolve from the APPROVE audit row')
    const approveAuditsGql = await getAudits(firstQueued.id)
    assert.equal(approveAuditsGql.length, 1, 'Exactly one audit row after GraphQL approval')
    assert.equal(approveAuditsGql[0]!.action, 'APPROVE')
    assert.equal(approveAuditsGql[0]!.performed_by, gqlManagerId, 'Audit must be attributed to the authenticated manager')
    console.log(`PASS 13c approveBooking → ${approveData.approveBooking.id} ${approveData.approveBooking.status}, processedAt ${approveData.approveBooking.processedAt}, audit by authenticated manager`)

    // --- SCENARIO 14: rejectBooking is gated by booking:reject, separately from approve (FR-54) ---
    const rejectTarget = await createPendingBooking(requesterId, gqlRoomId, 72)

    const rejectAnonymous = await gql(REJECT_MUTATION, { input: { id: rejectTarget.id, reason: 'Legitimate reason here' } }, anonymous)
    assert.equal(errorCode(rejectAnonymous), 'FORBIDDEN', 'Unauthenticated rejectBooking must be FORBIDDEN')
    console.log(`PASS 14a rejectBooking without a token → ${errorCode(rejectAnonymous)}`)

    const rejectWithApproveOnly = await gql(REJECT_MUTATION, { input: { id: rejectTarget.id, reason: 'Legitimate reason here' } }, approveOnly)
    assert.equal(errorCode(rejectWithApproveOnly), 'FORBIDDEN', 'booking:approve alone must not permit rejection')
    console.log(`PASS 14b rejectBooking with booking:approve only → ${errorCode(rejectWithApproveOnly)} (permissions are not interchangeable)`)

    const approveWithRejectOnly = await gql(APPROVE_MUTATION, { id: rejectTarget.id }, rejectOnly)
    assert.equal(errorCode(approveWithRejectOnly), 'FORBIDDEN', 'booking:reject alone must not permit approval')
    assert.equal(
      (await dataSource.getRepository(Booking).findOneByOrFail({ id: rejectTarget.id })).status,
      'PENDING',
      'Forbidden reject must not change status',
    )
    console.log(`PASS 14c approveBooking with booking:reject only → ${errorCode(approveWithRejectOnly)} (permissions are not interchangeable), booking stays PENDING`)

    const rejectOk = await gql(REJECT_MUTATION, { input: { id: rejectTarget.id, reason: 'Room is reserved for the all-hands' } }, bothPermissions)
    assert.equal(rejectOk.errors, undefined, `rejectBooking failed: ${JSON.stringify(rejectOk.errors?.map((e) => e.message))}`)
    const rejectData = rejectOk.data as { rejectBooking: { id: string; status: string; rejectionReason: string | null } }
    assert.equal(rejectData.rejectBooking.status, 'REJECTED')
    assert.equal(rejectData.rejectBooking.rejectionReason, 'Room is reserved for the all-hands')
    console.log(`PASS 14d rejectBooking → ${rejectData.rejectBooking.id} ${rejectData.rejectBooking.status}, reason "${rejectData.rejectBooking.rejectionReason}"`)

    // --- SCENARIO 15: short reason surfaces as a field error over GraphQL (FR-54) ---
    const shortReasonTarget = await createPendingBooking(requesterId, gqlRoomId, 73)
    const gqlShortReason = await gql(REJECT_MUTATION, { input: { id: shortReasonTarget.id, reason: 'no' } }, bothPermissions)
    assert.equal(errorCode(gqlShortReason), 'BAD_USER_INPUT', 'Short rejection reason must be BAD_USER_INPUT')
    const reasonFieldErrors = firstError(gqlShortReason).extensions?.fieldErrors as Array<{ field: string }> | undefined
    assert.ok(
      reasonFieldErrors?.some((fieldError) => fieldError.field === 'reason'),
      `Expected a field error for reason, got: ${JSON.stringify(firstError(gqlShortReason).extensions)}`,
    )
    assert.equal(
      (await dataSource.getRepository(Booking).findOneByOrFail({ id: shortReasonTarget.id })).status,
      'PENDING',
      'Refused short-reason reject must leave the booking PENDING',
    )
    console.log(`PASS 15 rejectBooking with short reason → ${errorCode(gqlShortReason)} fieldErrors=${JSON.stringify(reasonFieldErrors)}`)

    // --- SCENARIO 16: a decided booking cannot be decided again over GraphQL (FR-55) ---
    const reApprove = await gql(APPROVE_MUTATION, { id: firstQueued.id }, bothPermissions)
    assert.equal(errorCode(reApprove), 'BAD_USER_INPUT', 'Re-approving an APPROVED booking must be BAD_USER_INPUT')
    assert.match(firstError(reApprove).message, /Cannot approve booking from status: APPROVED/)
    console.log(`PASS 16a re-approve APPROVED booking → ${errorCode(reApprove)} "${firstError(reApprove).message}"`)

    const reReject = await gql(REJECT_MUTATION, { input: { id: rejectTarget.id, reason: 'Trying to reverse the decision' } }, bothPermissions)
    assert.equal(errorCode(reReject), 'BAD_USER_INPUT', 'Re-rejecting a REJECTED booking must be BAD_USER_INPUT')
    assert.match(firstError(reReject).message, /Cannot reject booking from status: REJECTED/)
    console.log(`PASS 16b re-reject REJECTED booking → ${errorCode(reReject)} "${firstError(reReject).message}"`)

    // --- SCENARIO 17: FR-56 holds through GraphQL, keyed on the authenticated employee ---
    const gqlSelfManagerId = await createEmployee('Approval', 'Gqlself', 'gqlself')
    const selfContext = contextFor(await loadEmployee(gqlSelfManagerId), ['booking:approve', 'booking:reject'])
    const gqlSelfBooking = await createPendingBooking(gqlSelfManagerId, gqlRoomId, 74)

    const selfApprove = await gql(APPROVE_MUTATION, { id: gqlSelfBooking.id }, selfContext)
    assert.equal(errorCode(selfApprove), 'BAD_USER_INPUT', 'Self-approval must be refused')
    assert.match(firstError(selfApprove).message, /A manager cannot approve or reject their own booking request/)
    console.log(`PASS 17a self-approval over GraphQL → ${errorCode(selfApprove)} "${firstError(selfApprove).message}"`)

    const selfReject = await gql(REJECT_MUTATION, { input: { id: gqlSelfBooking.id, reason: 'Deciding on my own request' } }, selfContext)
    assert.equal(errorCode(selfReject), 'BAD_USER_INPUT', 'Self-rejection must be refused')
    assert.match(firstError(selfReject).message, /A manager cannot approve or reject their own booking request/)
    const selfAfter = await dataSource.getRepository(Booking).findOneByOrFail({ id: gqlSelfBooking.id })
    assert.equal(selfAfter.status, 'PENDING', 'Refused self-decision must leave the booking PENDING')
    assert.equal(selfAfter.rejectionReason, null, 'Refused self-rejection must not persist a reason')
    console.log('PASS 17b self-rejection over GraphQL refused, booking stays PENDING with no reason')

    const peerContext = contextFor(await loadEmployee(gqlPeerId), ['booking:approve', 'booking:reject'])
    const peerDecision = await gql(APPROVE_MUTATION, { id: gqlSelfBooking.id }, peerContext)
    assert.equal(peerDecision.errors, undefined, `Peer approve failed: ${JSON.stringify(peerDecision.errors?.map((e) => e.message))}`)
    const peerData = peerDecision.data as { approveBooking: { id: string; status: string } }
    assert.equal(peerData.approveBooking.status, 'APPROVED', 'A different manager must be able to decide the same booking')
    assert.equal((await getAudits(gqlSelfBooking.id))[0]!.performed_by, gqlPeerId, 'Audit must be attributed to the deciding manager')
    console.log(`PASS 17c different manager approves the creator's booking over GraphQL → ${peerData.approveBooking.id} ${peerData.approveBooking.status}`)

    console.log('ALL S8 ACCEPTANCE TESTS PASSED')
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
