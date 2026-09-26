import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { graphql, printSchema, type ExecutionResult } from 'graphql'
import { buildSchema } from 'type-graphql'
import type { Logger } from 'typeorm'
import { authChecker } from '../../../auth/auth-checker'
import { createDataSource } from '../../../config/data-source'
import { formatError } from '../../../common/errors/format-error'
import { DomainError } from '../../../common/errors/domain-error'
import type { GraphQLContext } from '../../../common/graphql/context'
import { createLoaders } from '../../../loaders'
import { loadEnv } from '../../../config/env'
import { AuditLog } from '../../audit/audit-log.entity'
import { Booking } from '../../booking/booking.entity'
import { BookingEquipment } from '../../booking/booking-equipment.entity'
import { Employee } from '../../employee/employee.entity'
import { Equipment } from '../../equipment/equipment.entity'
import { MeetingRoom } from '../../room/room.entity'
import { UserRole } from '../../rbac/user-role.entity'
import { ReportResolver } from '../report.resolver'
import { ReportService } from '../report.service'
import { ReportRangeInput } from '../report.inputs'

interface GqlError {
  message: string
  extensions?: Record<string, unknown>
}

interface CapturedQuery {
  sql: string
  parameters?: unknown[]
}

/**
 * Captures the SQL TypeORM actually hands to the driver, so the FR-70 proof is
 * about the real statement rather than a reconstruction of it.
 */
class CapturingLogger implements Logger {
  readonly captured: CapturedQuery[] = []

  logQuery(query: string, parameters?: unknown[]): void {
    this.captured.push({ sql: query, parameters })
  }

  logQueryError(error: Error): void {
    console.error('[sql error]', error.message)
  }

  logQuerySlow(): void {}

  logSchemaBuild(): void {}

  logMigration(): void {}

  log(): void {}

  logError(message: string, error?: Error): void {
    console.error(message, error)
  }

  logWarning(message: string): void {
    console.warn(message)
  }

  logSuccess(): void {}
}

const utc = (value: string): Date => new Date(`${value}Z`)

/** 2026-03-01T00:00:00Z .. 2026-03-15T00:00:00Z — half-open, per the module contract. */
const RANGE_FROM = utc('2026-03-01T00:00:00')
const RANGE_TO = utc('2026-03-15T00:00:00')

const range = (from: Date, to: Date): ReportRangeInput => ({ from, to })

async function main(): Promise<void> {
  loadEnv()
  const dataSource = createDataSource()
  await dataSource.initialize()

  const logger = new CapturingLogger()
  dataSource.setOptions({ logger, logging: ['query'] })

  const service = new ReportService()
  const manager = dataSource.manager
  const runId = randomUUID()
  const employeeIds: string[] = []
  const roomIds: string[] = []
  const equipmentIds: string[] = []
  const bookingIds: string[] = []

  const eq = (value: unknown): string => `  ${value}`

  try {
    const employeeRepository = dataSource.getRepository(Employee)
    const roomRepository = dataSource.getRepository(MeetingRoom)
    const equipmentRepository = dataSource.getRepository(Equipment)
    const bookingRepository = dataSource.getRepository(Booking)
    const lineRepository = dataSource.getRepository(BookingEquipment)
    const auditRepository = dataSource.getRepository(AuditLog)

    const roleRows = (await dataSource.query(
      "SELECT role_name, id FROM role WHERE role_name IN ('Employee', 'Admin')",
    )) as Array<{ role_name: string; id: string }>
    const adminRoleId = roleRows.find((r) => r.role_name === 'Admin')?.id
    assert.ok(adminRoleId, 'Admin role required (run npm run seed)')

    const createEmployee = async (firstName: string, lastName: string): Promise<Employee> => {
      const employee = await employeeRepository.save(
        employeeRepository.create({
          firstName,
          lastName,
          email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}-${runId}@resource.local`,
          password: 'hash',
        }),
      )
      employeeIds.push(employee.id)
      await dataSource.getRepository(UserRole).save(
        dataSource.getRepository(UserRole).create({ employeeId: employee.id, roleId: adminRoleId }),
      )
      return employee
    }

    const alice = await createEmployee('Alice', 'Report')
    const bob = await createEmployee('Bob', 'Report')
    const carol = await createEmployee('Carol', 'Gone')

    const createRoom = async (name: string, capacity: number): Promise<MeetingRoom> => {
      const room = await roomRepository.save(
        roomRepository.create({ name: `${name} ${runId}`, location: `Loc-${name}`, capacity, isActive: true }),
      )
      roomIds.push(room.id)
      return room
    }

    const roomA = await createRoom('A', 4)
    const roomB = await createRoom('B', 8)
    const roomC = await createRoom('C', 2)

    const equipmentOne = await equipmentRepository.save(
      equipmentRepository.create({ name: `Projector ${runId}`, quantityAvailable: 5, isActive: true }),
    )
    equipmentIds.push(equipmentOne.id)
    const equipmentTwo = await equipmentRepository.save(
      equipmentRepository.create({ name: `Whiteboard ${runId}`, quantityAvailable: 4, isActive: true }),
    )
    equipmentIds.push(equipmentTwo.id)

    type BookingSpec = {
      key: string
      employee: Employee
      room: MeetingRoom
      start: string
      end: string
      status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'COMPLETED'
      createdAt: string
      equipment?: Array<{ equipment: Equipment; quantity: number }>
    }

    const specs: BookingSpec[] = [
      { key: 'B1', employee: alice, room: roomA, start: '2026-03-02T09:00:00', end: '2026-03-02T10:00:00', status: 'APPROVED', createdAt: '2026-01-05T09:00:00', equipment: [{ equipment: equipmentOne, quantity: 3 }] },
      { key: 'B2', employee: bob, room: roomA, start: '2026-03-03T09:00:00', end: '2026-03-03T12:00:00', status: 'COMPLETED', createdAt: '2026-03-02T09:00:00', equipment: [{ equipment: equipmentOne, quantity: 2 }] },
      { key: 'B3', employee: alice, room: roomA, start: '2026-03-04T09:00:00', end: '2026-03-04T10:00:00', status: 'REJECTED', createdAt: '2026-01-20T09:00:00' },
      { key: 'B4', employee: alice, room: roomB, start: '2026-03-05T09:00:00', end: '2026-03-05T11:00:00', status: 'APPROVED', createdAt: '2026-03-04T09:00:00', equipment: [{ equipment: equipmentTwo, quantity: 1 }] },
      { key: 'B5', employee: bob, room: roomB, start: '2026-03-06T09:00:00', end: '2026-03-06T10:00:00', status: 'CANCELLED', createdAt: '2026-03-05T09:00:00' },
      { key: 'B6', employee: bob, room: roomB, start: '2026-03-20T09:00:00', end: '2026-03-20T10:00:00', status: 'APPROVED', createdAt: '2026-03-06T09:00:00', equipment: [{ equipment: equipmentTwo, quantity: 4 }] },
      { key: 'B7', employee: bob, room: roomC, start: '2026-03-07T09:00:00', end: '2026-03-07T10:00:00', status: 'PENDING', createdAt: '2026-03-07T09:00:00', equipment: [{ equipment: equipmentOne, quantity: 1 }] },
      { key: 'B8', employee: carol, room: roomC, start: '2026-03-08T09:00:00', end: '2026-03-08T10:00:00', status: 'APPROVED', createdAt: '2026-03-08T09:00:00', equipment: [{ equipment: equipmentOne, quantity: 2 }] },
      // Straddles the range start: 2h long, but only 1h of it is inside [from, to).
      { key: 'B9', employee: alice, room: roomA, start: '2026-02-28T23:00:00', end: '2026-03-01T01:00:00', status: 'APPROVED', createdAt: '2026-02-10T09:00:00', equipment: [{ equipment: equipmentOne, quantity: 2 }] },
    ]

    const bookings: Record<string, Booking> = {}
    for (const spec of specs) {
      // Inserted as PENDING (the only state the create path guarantees) and moved
      // to its final status afterwards, because the room+time-range exclusion
      // constraint is evaluated per row as written.
      const booking = await bookingRepository.save(
        bookingRepository.create({
          employeeId: spec.employee.id,
          roomId: spec.room.id,
          startTime: utc(spec.start),
          endTime: utc(spec.end),
          purpose: `Report fixture ${spec.key}`,
          numberOfAttendees: 1,
          status: 'PENDING',
        }),
      )
      bookingIds.push(booking.id)
      bookings[spec.key] = booking
      if (spec.status !== 'PENDING') {
        await dataSource.query('UPDATE booking SET status = $2 WHERE id = $1', [booking.id, spec.status])
      }
      await dataSource.query('UPDATE booking SET created_at = $2, updated_at = $2 WHERE id = $1', [
        booking.id,
        utc(spec.createdAt),
      ])
      for (const line of spec.equipment ?? []) {
        await lineRepository.save(
          lineRepository.create({ bookingId: booking.id, equipmentId: line.equipment.id, quantity: line.quantity }),
        )
      }
    }

    const decisionSpecs: Array<{ key: string; action: 'APPROVE' | 'REJECT' | 'CANCEL' | 'COMPLETE'; at: string }> = [
      { key: 'B1', action: 'APPROVE', at: '2026-01-06T10:00:00' },
      { key: 'B3', action: 'REJECT', at: '2026-01-21T10:00:00' },
      { key: 'B9', action: 'APPROVE', at: '2026-02-11T10:00:00' },
      { key: 'B2', action: 'COMPLETE', at: '2026-03-08T13:00:00' },
      { key: 'B4', action: 'APPROVE', at: '2026-03-11T10:00:00' },
      { key: 'B5', action: 'CANCEL', at: '2026-03-12T10:00:00' },
      { key: 'B6', action: 'APPROVE', at: '2026-03-13T10:00:00' },
      { key: 'B8', action: 'APPROVE', at: '2026-03-14T10:00:00' },
    ]
    for (const decision of decisionSpecs) {
      const booking = bookings[decision.key]!
      const row = await auditRepository.save(
        auditRepository.create({
          bookingId: booking.id,
          action: decision.action,
          oldStatus: 'PENDING',
          newStatus: booking.status,
          performedById: alice.id,
        }),
      )
      await dataSource.query('UPDATE audit_log SET created_at = $2 WHERE id = $1', [row.id, utc(decision.at)])
    }

    // FR-7: the requesting employee record is a hard delete; the booking stays
    // queryable with employee_id = NULL, which the report must label, not crash on.
    await dataSource.query('DELETE FROM user_role WHERE employee_id = $1', [carol.id])
    await dataSource.query('DELETE FROM employee WHERE id = $1', [carol.id])
    const orphanedBooking = (await bookingRepository.findOneByOrFail({ id: bookings.B8!.id })).employeeId
    assert.equal(orphanedBooking, null, 'FR-7 fixture precondition: B8 must have a NULL requester')
    employeeIds.splice(employeeIds.indexOf(carol.id), 1)
    console.log('PASS fixture: 3 rooms, 2 employees (+1 deleted), 2 equipment, 9 bookings, 8 audit rows')

    // ---------------------------------------------------------------- helpers
    let reportCalls = 0
    const capturedFor = async <T>(label: string, run: () => Promise<T>, aggregatePattern: RegExp): Promise<{ result: T; sql: string }> => {
      const before = logger.captured.length
      const result = await run()
      const statements = logger.captured.slice(before)
      assert.equal(statements.length, 1, `${label}: expected exactly one round-trip, got ${statements.length}`)
      const statement = statements[0]!
      assert.match(statement.sql, /GROUP\s+BY/i, `${label}: SQL must aggregate in the database (FR-70)\n${statement.sql}`)
      assert.match(statement.sql, aggregatePattern, `${label}: SQL must use aggregate functions (FR-70)\n${statement.sql}`)
      const plan = (await dataSource.query(`EXPLAIN (COSTS OFF) ${statement.sql}`, statement.parameters ?? [])) as Array<{ 'QUERY PLAN': string }>
      assert.ok(plan.length > 0, `${label}: Postgres must plan the report SQL`)
      reportCalls += 1
      console.log(`\n--- ${label}: SQL actually sent to Postgres (FR-70) ---`)
      console.log(eq(statement.sql.replace(/ {2,}/g, '\n  ').trim()))
      console.log(eq(`EXPLAIN: ${plan.map((row) => row['QUERY PLAN']).join(' | ')}`))
      return { result, sql: statement.sql }
    }

    // ---------------------------------------------------- FR-66 rooms ranked
    // In range [03-01, 03-15): room A = B1, B2, B3, B9 (B9 straddles from);
    // room B = B4, B5 (B6 is on 03-20, outside); room C = B7, B8.
    const { result: roomRows } = await capturedFor(
      'FR-66 mostBookedRooms',
      () => service.mostBookedRooms(manager, range(RANGE_FROM, RANGE_TO), null),
      /COUNT\s*\(/i,
    )
    console.log(`\nFR-66 rows: ${JSON.stringify(roomRows)}`)
    assert.equal(roomRows.length, 3)
    assert.deepEqual(
      roomRows.map((row) => [row.roomName.split(' ')[0], row.bookingCount]),
      [['A', 4], ['B', 2], ['C', 2]],
      'FR-66 must rank room A first with 4, then B and C tied on 2 broken by name ASC',
    )
    assert.equal(roomRows[0]!.capacity, 4)
    assert.equal(roomRows[0]!.location, 'Loc-A')
    const limited = await service.mostBookedRooms(manager, range(RANGE_FROM, RANGE_TO), 2)
    assert.equal(limited.length, 2, 'FR-66 limit must bound the row set (NFR-2)')
    assert.deepEqual(limited.map((row) => row.bookingCount), [4, 2])
    const outside = await service.mostBookedRooms(manager, range(utc('2026-03-19T00:00:00'), utc('2026-03-21T00:00:00')), null)
    assert.equal(outside.length, 1)
    assert.equal(outside[0]!.roomId, roomB.id)
    assert.equal(outside[0]!.bookingCount, 1, 'A narrow range must return only the overlapping booking')
    console.log('PASS FR-66 mostBookedRooms ranks A(4) > B(2) = C(2), limit 2 truncates, narrow range returns B alone')

    // ------------------------------------------------- FR-67 per-employee counts
    // Alice: B1 APPROVED, B3 REJECTED, B4 APPROVED, B9 APPROVED = 4 (3 approved).
    // Bob:   B2 COMPLETED, B5 CANCELLED, B6 APPROVED, B7 PENDING   = 4.
    // Carol: B8 APPROVED, requester row deleted (FR-7)               = 1.
    const { result: employeeRows } = await capturedFor(
      'FR-67 bookingsPerEmployee',
      () => service.bookingsPerEmployee(manager, null, null),
      /COUNT\s*\([^)]*\)\s*FILTER/i,
    )
    console.log(`\nFR-67 rows: ${JSON.stringify(employeeRows)}`)
    assert.equal(employeeRows.length, 3)
    const aliceRow = employeeRows.find((row) => row.employeeId === alice.id)!
    const bobRow = employeeRows.find((row) => row.employeeId === bob.id)!
    const deletedRow = employeeRows.find((row) => row.employeeId === null)!
    assert.deepEqual(
      {
        totalCount: aliceRow.totalCount,
        pendingCount: aliceRow.pendingCount,
        approvedCount: aliceRow.approvedCount,
        rejectedCount: aliceRow.rejectedCount,
        cancelledCount: aliceRow.cancelledCount,
        completedCount: aliceRow.completedCount,
      },
      { totalCount: 4, pendingCount: 0, approvedCount: 3, rejectedCount: 1, cancelledCount: 0, completedCount: 0 },
      'FR-67 Alice breakdown must be 4 total / 3 approved / 1 rejected',
    )
    assert.deepEqual(
      {
        totalCount: bobRow.totalCount,
        pendingCount: bobRow.pendingCount,
        approvedCount: bobRow.approvedCount,
        rejectedCount: bobRow.rejectedCount,
        cancelledCount: bobRow.cancelledCount,
        completedCount: bobRow.completedCount,
      },
      { totalCount: 4, pendingCount: 1, approvedCount: 1, rejectedCount: 0, cancelledCount: 1, completedCount: 1 },
      'FR-67 Bob breakdown must be 4 total / 1 approved / 1 pending / 1 cancelled / 1 completed',
    )
    assert.equal(deletedRow.totalCount, 1)
    assert.equal(deletedRow.displayName, 'Deleted user', 'FR-7: a deleted requester must render as "Deleted user"')
    assert.equal(deletedRow.email, null)
    assert.deepEqual(
      employeeRows.map((row) => row.totalCount),
      [4, 4, 1],
      'FR-67 must order by total DESC, then by name ASC with the NULL group last',
    )
    const ranged = await service.bookingsPerEmployee(manager, range(RANGE_FROM, RANGE_TO), null)
    const rangedBob = ranged.find((row) => row.employeeId === bob.id)!
    assert.equal(rangedBob.totalCount, 3, 'FR-67 range must drop B6, which starts after the range')
    assert.equal(ranged.find((row) => row.employeeId === alice.id)!.totalCount, 4, 'FR-67 range keeps the straddling B9')
    console.log('PASS FR-67 bookingsPerEmployee exact per-status breakdown for 2 employees + "Deleted user" group')

    // ----------------------------------------------- FR-68 equipment quantity-hours
    // Projector, PENDING+APPROVED in range, clipped to the range:
    //   B1 3 x 1h = 3.0 | B7 1 x 1h = 1.0 | B8 2 x 1h = 2.0 | B9 2 x 1h = 2.0 -> 8.0
    // Whiteboard: B4 1 x 2h = 2.0 (B6's 4 x 1h = 4.0 falls outside the range).
    const { result: usageRows } = await capturedFor(
      'FR-68 equipmentUsage',
      () => service.equipmentUsage(manager, range(RANGE_FROM, RANGE_TO), null, null),
      /SUM\s*\(|EXTRACT\s*\(\s*EPOCH/i,
    )
    console.log(`\nFR-68 rows: ${JSON.stringify(usageRows)}`)
    assert.equal(usageRows.length, 2)
    assert.equal(usageRows[0]!.equipmentId, equipmentOne.id)
    assert.equal(usageRows[0]!.equipmentName, `Projector ${runId}`)
    assert.equal(usageRows[0]!.totalQuantityHours, 8, 'FR-68 must compute 8 quantity-hours for the projector')
    assert.equal(usageRows[0]!.totalQuantityCommitted, 8)
    assert.equal(usageRows[0]!.bookingCount, 4)
    assert.equal(usageRows[0]!.quantityAvailable, 5)
    assert.equal(usageRows[1]!.equipmentId, equipmentTwo.id)
    assert.equal(usageRows[1]!.totalQuantityHours, 2, 'FR-68 must compute 2 quantity-hours for the whiteboard')
    assert.equal(usageRows[1]!.bookingCount, 1)
    const nonCommitted = await service.equipmentUsage(
      manager,
      range(RANGE_FROM, RANGE_TO),
      ['COMPLETED', 'CANCELLED', 'REJECTED'],
      null,
    )
    assert.equal(nonCommitted.length, 1, 'Only the projector has non-committed lines in range')
    assert.equal(nonCommitted[0]!.totalQuantityHours, 6, 'FR-68 B2 is 2 units x 3h = 6 quantity-hours')
    const allStatuses = await service.equipmentUsage(manager, range(RANGE_FROM, RANGE_TO), ['PENDING', 'APPROVED', 'COMPLETED'], null)
    assert.deepEqual(
      allStatuses.map((row) => [row.equipmentName.split(' ')[0], row.totalQuantityHours]),
      [['Projector', 14], ['Whiteboard', 2]],
      'FR-68 with COMPLETED added must fold B2 2 x 3h into the projector total (8 + 6 = 14)',
    )
    console.log('PASS FR-68 equipmentUsage quantity-hours 8.0 / 2.0, clipped at the range boundary, status filter honoured')

    // ------------------------------------------------- FR-69 monthly statistics
    // created:  Jan = B1, B3 (2) | Feb = B9 (1) | Mar = B2, B4, B5, B6, B7, B8 (6)
    // approved: Jan = B1 | Feb = B9 | Mar = B4, B6, B8   (B2's COMPLETE is not an approval)
    // rejected: Jan = B3   cancelled: Mar = B5
    const { result: monthlyRows } = await capturedFor(
      'FR-69 monthlyBookingStatistics',
      () => service.monthlyBookingStatistics(manager, null, null),
      /COUNT\s*\([^)]*\)\s*FILTER|SUM\s*\(/i,
    )
    console.log(`\nFR-69 rows: ${JSON.stringify(monthlyRows)}`)
    assert.deepEqual(monthlyRows, [
      { month: '2026-01', created: 2, approved: 1, rejected: 1, cancelled: 0 },
      { month: '2026-02', created: 1, approved: 1, rejected: 0, cancelled: 0 },
      { month: '2026-03', created: 6, approved: 3, rejected: 0, cancelled: 1 },
    ])
    const createdTotal = monthlyRows.reduce((sum, row) => sum + row.created, 0)
    assert.equal(createdTotal, bookingIds.length, 'FR-69 created counts must account for every fixture booking exactly once')
    const fromFebruary = await service.monthlyBookingStatistics(
      manager,
      range(utc('2026-02-01T00:00:00'), utc('2026-04-01T00:00:00')),
      null,
    )
    assert.deepEqual(
      fromFebruary.map((row) => row.month),
      ['2026-02', '2026-03'],
      'FR-69 range must drop the January bucket',
    )
    console.log('PASS FR-69 monthlyBookingStatistics per-month created/approved/rejected/cancelled match hand-computed values')

    // ------------------------------------------------ argument validation
    await assert.rejects(
      () => service.mostBookedRooms(manager, range(RANGE_TO, RANGE_FROM), null),
      (error: unknown) => error instanceof DomainError && /strictly before/.test(error.message),
      'An inverted range must be refused',
    )
    await assert.rejects(
      () => service.equipmentUsage(manager, range(RANGE_FROM, RANGE_TO), [], null),
      (error: unknown) => error instanceof DomainError && /Invalid booking status filter/.test(error.message),
      'An empty status filter must be refused',
    )
    console.log('PASS inverted range and empty status filter are refused with DomainError')

    // ------------------------------------------------------ GraphQL + gating
    const schema = await buildSchema({ resolvers: [ReportResolver], authChecker, validate: true })
    const sdl = printSchema(schema)

    const contextFor = (employee: Employee | null, permissions: string[]): GraphQLContext =>
      ({
        dataSource,
        auth:
          employee === null
            ? null
            : { employee, permissionKeys: new Set<string>(permissions) },
        loaders: createLoaders(dataSource),
      }) as unknown as GraphQLContext

    const runQuery = async (
      source: string,
      variableValues: Record<string, unknown>,
      contextValue: GraphQLContext,
    ): Promise<ExecutionResult> => graphql({ schema, source, variableValues, contextValue })

    const ROOMS_QUERY = `query MostBookedRooms($range: ReportRangeInput!) { mostBookedRooms(range: $range) { roomId roomName location capacity bookingCount } }`
    const EMPLOYEE_QUERY = `query BookingsPerEmployee($range: ReportRangeInput, $limit: Int) { bookingsPerEmployee(range: $range, limit: $limit) { employeeId displayName email totalCount pendingCount approvedCount rejectedCount cancelledCount completedCount } }`
    const USAGE_QUERY = `query EquipmentUsage($range: ReportRangeInput!, $statuses: [ReportBookingStatus!]) { equipmentUsage(range: $range, statuses: $statuses) { equipmentId equipmentName quantityAvailable bookingCount totalQuantityCommitted totalQuantityHours } }`
    const MONTHLY_QUERY = `query MonthlyBookingStatistics($range: ReportRangeInput) { monthlyBookingStatistics(range: $range) { month created approved rejected cancelled } }`

    const permitted = contextFor(alice, ['report:read'])
    const unprivileged = contextFor(alice, ['booking:read:all', 'audit:read'])
    const anonymous = contextFor(null, [])

    const requireData = <T>(result: ExecutionResult): T => {
      assert.equal(result.errors, undefined, JSON.stringify(result.errors))
      assert.notEqual(result.data, null)
      return result.data as T
    }
    const formattedError = (result: ExecutionResult): GqlError => {
      const error = result.errors?.[0]
      assert.notEqual(error, undefined, 'Expected a GraphQL error')
      return formatError(error!.toJSON(), error!) as GqlError
    }
    const errorCode = (result: ExecutionResult): string | undefined =>
      formattedError(result).extensions?.code as string | undefined
    const errorMessage = (result: ExecutionResult): string => formattedError(result).message

    const variables = { range: { from: RANGE_FROM.toISOString(), to: RANGE_TO.toISOString() } }

    const gqlRooms = requireData<{ mostBookedRooms: Array<{ bookingCount: number }> }>(
      await runQuery(ROOMS_QUERY, { range: variables.range }, permitted),
    )
    assert.deepEqual(gqlRooms.mostBookedRooms.map((row) => row.bookingCount), [4, 2, 2])
    const gqlUsage = requireData<{ equipmentUsage: Array<{ totalQuantityHours: number }> }>(
      await runQuery(USAGE_QUERY, { range: variables.range }, permitted),
    )
    assert.deepEqual(gqlUsage.equipmentUsage.map((row) => row.totalQuantityHours), [8, 2])
    const gqlMonthly = requireData<{ monthlyBookingStatistics: Array<{ month: string; created: number }> }>(
      await runQuery(MONTHLY_QUERY, { range: null }, permitted),
    )
    assert.deepEqual(
      gqlMonthly.monthlyBookingStatistics.map((row) => `${row.month}:${row.created}`),
      ['2026-01:2', '2026-02:1', '2026-03:6'],
    )
    const gqlEmployee = requireData<{ bookingsPerEmployee: Array<{ totalCount: number; displayName: string }> }>(
      await runQuery(EMPLOYEE_QUERY, { range: null, limit: 5 }, permitted),
    )
    assert.deepEqual(
      gqlEmployee.bookingsPerEmployee.map((row) => `${row.displayName}:${row.totalCount}`),
      ['Alice Report:4', 'Bob Report:4', 'Deleted user:1'],
    )
    console.log('PASS GraphQL returns identical figures for all four report queries')

    for (const [label, source] of [
      ['mostBookedRooms', ROOMS_QUERY],
      ['bookingsPerEmployee', EMPLOYEE_QUERY],
      ['equipmentUsage', USAGE_QUERY],
      ['monthlyBookingStatistics', MONTHLY_QUERY],
    ] as const) {
      const withoutPermission = await runQuery(source, { range: variables.range, statuses: null }, unprivileged)
      assert.equal(errorCode(withoutPermission), 'FORBIDDEN', `${label} must be FORBIDDEN without report:read`)
      assert.equal(errorMessage(withoutPermission), 'Not authorised', `${label} must not disclose the missing permission`)
      const unauthenticated = await runQuery(source, { range: variables.range, statuses: null }, anonymous)
      assert.equal(errorCode(unauthenticated), 'FORBIDDEN', `${label} must be FORBIDDEN without a token`)
    }
    console.log('PASS all four report queries are gated by report:read (FORBIDDEN + generic message, no data)')

    const schemaFields = (typeName: string): string[] => {
      const match = new RegExp(`type ${typeName} \\{([\\s\\S]*?)\\n\\}`, 'm').exec(sdl)
      if (match === null) return []
      return (match[1] ?? '')
        .split('\n')
        .map((line) => line.trim().split('(')[0] ?? '')
        .filter((field) => field.length > 0)
    }
    const queryFields = schemaFields('Query')
    const mutationFields = schemaFields('Mutation')
    for (const field of ['mostBookedRooms', 'bookingsPerEmployee', 'equipmentUsage', 'monthlyBookingStatistics']) {
      assert.ok(queryFields.includes(field), `${field} must be exposed as a query`)
    }
    assert.equal(
      mutationFields.some((field) => /mostBookedRooms|bookingsPerEmployee|equipmentUsage|monthlyBookingStatistics/.test(field)),
      false,
      `the report module must expose no mutations, found: ${mutationFields.join(', ')}`,
    )
    console.log(`PASS report module is read-only: ${queryFields.length} queries in the schema, mutations = [${mutationFields.join(', ')}]`)

    assert.equal(reportCalls, 4, 'all four reports proved a single aggregated statement each')
    console.log('\nALL REPORT ACCEPTANCE TESTS PASSED')
  } finally {
    const idList = (ids: string[]): string => ids.map((_, index) => `$${index + 1}`).join(',')
    if (bookingIds.length > 0) {
      await dataSource.query(`DELETE FROM notification WHERE booking_id IN (${idList(bookingIds)})`, bookingIds)
      await dataSource.query(`DELETE FROM audit_log WHERE booking_id IN (${idList(bookingIds)})`, bookingIds)
      await dataSource.query(`DELETE FROM booking_equipment WHERE booking_id IN (${idList(bookingIds)})`, bookingIds)
      await dataSource.query(`DELETE FROM booking WHERE id IN (${idList(bookingIds)})`, bookingIds)
    }
    if (roomIds.length > 0) {
      await dataSource.query(`DELETE FROM meeting_room WHERE id IN (${idList(roomIds)})`, roomIds)
    }
    if (equipmentIds.length > 0) {
      await dataSource.query(`DELETE FROM equipment WHERE id IN (${idList(equipmentIds)})`, equipmentIds)
    }
    if (employeeIds.length > 0) {
      await dataSource.query(`DELETE FROM user_role WHERE employee_id IN (${idList(employeeIds)})`, employeeIds)
      await dataSource.query(`DELETE FROM employee WHERE id IN (${idList(employeeIds)})`, employeeIds)
    }
    if (dataSource.isInitialized) {
      await dataSource.destroy()
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
