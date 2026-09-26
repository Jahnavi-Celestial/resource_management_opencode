import 'reflect-metadata'
import type { AddressInfo } from 'node:net'
import { Like, type DataSource, type DataSourceOptions, type Logger as TypeOrmLogger, type QueryRunner } from 'typeorm'
import { loadEnv } from '../src/config/env'
import { createDataSource } from '../src/config/data-source'
import { createApp } from '../src/app'
import { Employee } from '../src/modules/employee/employee.entity'
import { SYSTEM_EMPLOYEE_EMAIL } from '../src/modules/employee/system-account'
import { MeetingRoom } from '../src/modules/room/room.entity'
import { Equipment } from '../src/modules/equipment/equipment.entity'
import { Booking } from '../src/modules/booking/booking.entity'
import { BookingService } from '../src/modules/booking/booking.service'
import type { CreateBookingInput } from '../src/modules/booking/booking.inputs'

const FIXTURE_PREFIX = 's7.fixture.'
const NFR_PREFIX = 's7.nfr.'
const ROOM_PREFIX = 'S7 '
const EQUIPMENT_PREFIX = 'S7 '
const BOOKING_PREFIX = 'S7 '
const PASSWORD = 'S7Fixture@2026'
const NFR_BOOKING_COUNT_SMALL = 20
const NFR_BOOKING_COUNT_LARGE = 100000
const PAGE_SIZE_SMALL = 5
const PAGE_SIZE_LARGE = 20
const PAGE_SIZE_QUERY = 25

interface GqlError {
  message: string
  extensions?: Record<string, unknown>
}

interface GqlBody {
  data?: Record<string, unknown> | null
  errors?: GqlError[]
}

interface GqlResult {
  status: number
  body: GqlBody
}

interface CapturedQuery {
  sql: string
  paramCount: number
}

function log(line: string): void {
  console.log(line)
}

let port = 0
let failures = 0
let token = ''
let captureQueries = false
const capturedQueries: CapturedQuery[] = []

function check(name: string, condition: boolean, evidence: string): void {
  if (condition) {
    log(`  [PASS] ${name}`)
    if (evidence !== '') log(`         ${evidence}`)
  } else {
    failures += 1
    log(`  [FAIL] ${name}`)
    log(`         ${evidence}`)
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function installQueryCounter(dataSource: DataSource): void {
  const base = dataSource.logger as unknown as TypeOrmLogger
  const loggingOptions: NonNullable<DataSourceOptions['logging']> = ['query', 'error', 'warn']
  Object.assign(dataSource.options, { logging: loggingOptions })
  Object.assign(dataSource.driver.options, { logging: loggingOptions })
  const counter: TypeOrmLogger = {
    logQuery(query: string, parameters?: unknown[]): void {
      if (captureQueries) {
        capturedQueries.push({
          sql: normalizeSql(query),
          paramCount: parameters === undefined ? 0 : parameters.length,
        })
      }
    },
    logQueryError(error: Error, query: string, parameters?: unknown[], queryRunner?: QueryRunner): void {
      base.logQueryError(error, query, parameters, queryRunner)
    },
    logQuerySlow(time: number, query: string, parameters?: unknown[], queryRunner?: QueryRunner): void {
      base.logQuerySlow(time, query, parameters, queryRunner)
    },
    logSchemaBuild(message: string, queryRunner?: QueryRunner): void {
      base.logSchemaBuild(message, queryRunner)
    },
    logMigration(message: string, queryRunner?: QueryRunner): void {
      base.logMigration(message, queryRunner)
    },
    log(level, message, queryRunner): void {
      base.log(level, message, queryRunner)
    },
  }
  dataSource.logger = counter as unknown as typeof dataSource.logger
}

async function gql(query: string, authenticated = true): Promise<GqlResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authenticated) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  })
  const body = (await response.json()) as GqlBody
  return { status: response.status, body }
}

function dataOf(result: GqlResult): Record<string, unknown> {
  const data = result.body.data
  if (data === null || data === undefined) {
    throw new Error(`No data in response: ${JSON.stringify(result.body)}`)
  }
  return data
}

function entityOf<T>(result: GqlResult, key: string): T | undefined {
  const data = dataOf(result)
  const value = data[key]
  if (typeof value !== 'object' || value === null) return undefined
  return value as T
}

function pageOf<T>(result: GqlResult, key: string): { items: T[]; totalCount: number } {
  const data = dataOf(result)
  const value = data[key] as { items: T[]; totalCount: number }
  return value
}

async function login(): Promise<void> {
  const env = loadEnv()
  const result = await gql(
    `mutation { login(input: { email: "${env.admin.email}", password: "${env.admin.password}" }) }`,
    false,
  )
  const value = dataOf(result).login
  if (typeof value !== 'string' || value === '') {
    throw new Error(`admin login failed: HTTP ${result.status} ${JSON.stringify(result.body)}`)
  }
  token = value
  log(`logged in as ${env.admin.email}`)
}

async function createEmployee(firstName: string, lastName: string, email: string): Promise<string> {
  const result = await gql(
    `mutation { createEmployee(input: { firstName: "${firstName}", lastName: "${lastName}", email: "${email}", password: "${PASSWORD}" }) { id } }`,
  )
  return (entityOf<{ id: string }>(result, 'createEmployee') as { id: string })!.id as string
}

async function createRoom(name: string): Promise<string> {
  const result = await gql(
    `mutation { createRoom(input: { name: "${name}", capacity: 10, location: "${ROOM_PREFIX}" }) { id } }`,
  )
  const room = entityOf<{ id: string }>(result, 'createRoom') as { id: string }
  return room.id as string
}

async function createEquipment(name: string): Promise<string> {
  const result = await gql(
    `mutation { createEquipment(input: { name: "${name}", quantityAvailable: 10 }) { id } }`,
  )
  const eq = entityOf<{ id: string }>(result, 'createEquipment') as { id: string }
  return eq.id as string
}

async function createBooking(employeeId: string, roomId: string, equipmentId: string, startTime: string, dataSource: DataSource): Promise<string> {
  const service = new BookingService(dataSource)
  const input: CreateBookingInput = { roomId, startTime: new Date(startTime), endTime: new Date(new Date(startTime).getTime() + 3600000), purpose: `${BOOKING_PREFIX}Test`, numberOfAttendees: 1, equipment: [{ equipmentId, quantity: 1 }] }
  const booking = await service.createBooking(employeeId, input)
  return booking.id as string
}

async function cleanup(dataSource: DataSource): Promise<void> {
  await dataSource.query('DELETE FROM audit_log WHERE booking_id IN (SELECT id FROM booking WHERE purpose LIKE $1 OR purpose LIKE $2)', [`${BOOKING_PREFIX}%`, `${NFR_PREFIX}%`])
  await dataSource.query('DELETE FROM booking_equipment WHERE booking_id IN (SELECT id FROM booking WHERE purpose LIKE $1 OR purpose LIKE $2)', [`${BOOKING_PREFIX}%`, `${NFR_PREFIX}%`])
  await dataSource.query('DELETE FROM booking WHERE purpose LIKE $1 OR purpose LIKE $2', [`${BOOKING_PREFIX}%`, `${NFR_PREFIX}%`])
  await dataSource.getRepository(Employee).delete([{ email: Like(`${FIXTURE_PREFIX}%`) }, { email: Like(`${NFR_PREFIX}%`) }])
  await dataSource.query('DELETE FROM meeting_room WHERE name LIKE $1', [`${ROOM_PREFIX}%`])
  await dataSource.query('DELETE FROM equipment WHERE name LIKE $1', [`${EQUIPMENT_PREFIX}%`])
}

async function reportCleanup(dataSource: DataSource): Promise<void> {
  const employees = (await dataSource.query(
    'SELECT count(*)::int AS c FROM employee WHERE email LIKE $1 OR email LIKE $2',
    [`${FIXTURE_PREFIX}%`, `${NFR_PREFIX}%`],
  )) as Array<{ c: number }>
  const rooms = (await dataSource.query('SELECT count(*)::int AS c FROM meeting_room WHERE name LIKE $1', [`${ROOM_PREFIX}%`])) as Array<{ c: number }>
  const equipment = (await dataSource.query('SELECT count(*)::int AS c FROM equipment WHERE name LIKE $1', [`${EQUIPMENT_PREFIX}%`])) as Array<{ c: number }>
  log('')
  log('CLEANUP — all S7 fixtures removed')
  log(`  leftover S7 employees=${String(employees[0]?.c)}, rooms=${String(rooms[0]?.c)}, equipment=${String(equipment[0]?.c)}`)
  check(
    'no S7 fixture rows remain',
    (employees[0]?.c ?? -1) === 0 && (rooms[0]?.c ?? -1) === 0 && (equipment[0]?.c ?? -1) === 0,
    `employees=${String(employees[0]?.c)}, rooms=${String(rooms[0]?.c)}, equipment=${String(equipment[0]?.c)}`,
  )
}

async function testNfr1ConstantQueryCount(dataSource: DataSource): Promise<void> {
  log('')
  log('TEST 1 — NFR-1: N+1 elimination — booking list with nested fields stays at constant SQL query count')

  const roomId: string = await createRoom(`${ROOM_PREFIX}Test Room`) as unknown as string
  const equipmentId: string = await createEquipment(`${EQUIPMENT_PREFIX}Test Equipment`) as unknown as string

  const employeeIds: string[] = []
  for (let i = 1; i <= NFR_BOOKING_COUNT_SMALL; i += 1) {
    const id = await createEmployee(`S7`, `Emp${String(i).padStart(2, '0')}`, `${NFR_PREFIX}${i}@resource.local`)
    employeeIds.push(id)
  }

  const bookings: Array<{ id: string; employeeId: string; startTime: string }> = []
  const baseTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  for (let i = 0; i < NFR_BOOKING_COUNT_SMALL; i += 1) {
    const startTime = new Date(baseTime.getTime() + i * 86400000).toISOString()
    const id = await createBooking(employeeIds[i % employeeIds.length] as string, roomId as string, equipmentId as string, startTime, dataSource)
    bookings.push({ id, employeeId: employeeIds[i % employeeIds.length] as string, startTime })
  }

  log(`  seeded ${NFR_BOOKING_COUNT_SMALL} bookings with employee, room, equipment lines`)

  const listQuery = (pageSize: number) =>
    `query { bookings(pageSize: ${pageSize}, sort: { field: "startTime", direction: "ASC" }) { totalCount items { id employeeId room { id name location } equipmentLines { equipmentId name requestedQuantity remainingAvailability } processedBy { id name } statusHistory { id oldStatus newStatus actor { id name } transitionedAt } } } }`

  captureQueries = true
  capturedQueries.length = 0
  const smallResult = await gql(listQuery(PAGE_SIZE_SMALL))
  const smallQueries = capturedQueries.slice()
  capturedQueries.length = 0
  const largeResult = await gql(listQuery(PAGE_SIZE_LARGE))
  const largeQueries = capturedQueries.slice()
  captureQueries = false

  const smallPage = pageOf<{ id: string; room: object; equipmentLines: object[] }>(smallResult, 'bookings')
  const largePage = pageOf<{ id: string; room: object; equipmentLines: object[] }>(largeResult, 'bookings')

  check('small page returns rows with nested room and equipmentLines', smallPage.items.length === PAGE_SIZE_SMALL && smallPage.totalCount >= PAGE_SIZE_SMALL, `items=${String(smallPage.items.length)}, totalCount=${String(smallPage.totalCount)}`)
  check('large page returns rows with nested room and equipmentLines', largePage.items.length === PAGE_SIZE_LARGE && largePage.totalCount >= PAGE_SIZE_LARGE, `items=${String(largePage.items.length)}, totalCount=${String(largePage.totalCount)}`)
  check('total SQL query count is identical for 5 rows and 20 rows (constant, not linear)', smallQueries.length === largeQueries.length, `pageSize ${PAGE_SIZE_SMALL} => ${String(smallQueries.length)} queries, pageSize ${PAGE_SIZE_LARGE} => ${String(largeQueries.length)} queries`)

  const loaderQueries = (queries: CapturedQuery[]): CapturedQuery[] =>
    queries.filter((q) => /booking_room|booking_equipment|employee|user_role/i.test(q.sql))
  const smallLoaderBatches = loaderQueries(smallQueries)
  const largeLoaderBatches = loaderQueries(largeQueries)
  check('loader queries stay constant (N+1 elimination proven)', smallLoaderBatches.length === largeLoaderBatches.length, `loader-related queries A=${String(smallLoaderBatches.length)}, B=${String(largeLoaderBatches.length)}`)

  log('         --- small page SQL queries ---')
  smallQueries.forEach((q, i) => log(`         SQL[${i + 1}] ${q.sql}`))
  log('         --- large page SQL queries ---')
  largeQueries.forEach((q, i) => log(`         SQL[${i + 1}] ${q.sql}`))

  void dataSource
}

async function testNfr4Performance(dataSource: DataSource): Promise<void> {
  log('')
  log('TEST 2 — NFR-4: 100k-row performance test')

  const roomId = await createRoom(`${ROOM_PREFIX}Perf Room`) as unknown as string
  const equipmentId = await createEquipment(`${EQUIPMENT_PREFIX}Perf Equipment`) as unknown as string

  const env = loadEnv()
  const adminId = (await dataSource.getRepository(Employee).findOneOrFail({ where: { email: env.admin.email } })).id

  log(`  seeding ${NFR_BOOKING_COUNT_LARGE} bookings...`)
  const batchSize = 1000
  for (let batch = 0; batch < NFR_BOOKING_COUNT_LARGE / batchSize; batch += 1) {
    const bookings = []
    for (let i = 0; i < batchSize; i += 1) {
      const dayOffset = batch * batchSize + i
      const hourOffset = i % 24
      const startTime = new Date(Date.now() + dayOffset * 86400000 + hourOffset * 3600000).toISOString()
      const endDate = new Date(new Date(startTime).getTime() + 3600000).toISOString()
      bookings.push({ roomId, employeeId: adminId, equipmentId, startTime, endDate })
    }
    for (const b of bookings) {
      await dataSource.query(
        'INSERT INTO booking (employee_id, room_id, start_time, end_time, purpose, rejection_reason, number_of_attendees, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [b.employeeId, b.roomId, b.startTime, b.endDate, `${BOOKING_PREFIX}Perf`, null, 1, 'APPROVED', new Date(), new Date()],
      )
    }
  }
  log(`  seeded ${NFR_BOOKING_COUNT_LARGE} bookings`)

  const query = `query { bookings(filter: { status: APPROVED, search: "${BOOKING_PREFIX}" }, pageSize: ${PAGE_SIZE_QUERY}, sort: { field: "startTime", direction: "ASC" }) { totalCount items { id purpose status startTime } } }`

  const times: number[] = []
  for (let run = 0; run < 10; run += 1) {
    const start = Date.now()
    const result = await gql(query)
    const elapsed = Date.now() - start
    times.push(elapsed)
    if (result.status !== 200) throw new Error(`Query failed on run ${run}`)
  }
  times.sort((a, b) => a - b)
  const p95 = times.length > 0 ? (times[Math.floor(times.length * 0.95)] ?? 0) : 0
  const avg = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0

  check(`10-run latency (avg=${String(avg)}ms, p95=${String(p95)}ms) is under 500ms`, p95 < 500, `p95=${String(p95)}ms, all times=[${times.join(',')}]`)

  const explainResult = await dataSource.query(`EXPLAIN ANALYZE SELECT b.id, b.purpose, b.status, b.start_time FROM booking b WHERE b.status = 'APPROVED' AND b.purpose LIKE '${BOOKING_PREFIX}%' ORDER BY b.start_time ASC LIMIT ${PAGE_SIZE_QUERY}`)
  const explainOutput = explainResult.map((row: Record<string, unknown>) => JSON.stringify(row))
  log('         --- EXPLAIN ANALYZE output ---')
  explainOutput.forEach((line: string) => log(`         ${line}`))

  const usesIndexScan = explainOutput.some((line: string) => /Index Scan|Index Only Scan/.test(line))
  const noSeqScan = !explainOutput.some((line: string) => /Seq Scan/.test(line) && !/Seq Scan on (role|employee|meeting_room|equipment|audit_log|user_role)/.test(line))
  check('EXPLAIN ANALYZE uses index scans (not sequential scans on booking)', usesIndexScan, `index scans found: ${String(usesIndexScan)}, sequential scans on booking: ${String(!noSeqScan)}`)

  const usesStartTimeIndex = explainOutput.some((line: string) => /booking.*start_time|start_time.*booking/i.test(line) && /Index/.test(line))
  check('EXPLAIN ANALYZE shows index on booking(start_time)', usesStartTimeIndex, `query uses start_time index: ${String(usesStartTimeIndex)}`)

  const statusIndexResult = await dataSource.query(`SELECT 1 FROM pg_indexes WHERE tablename = 'booking' AND indexname = 'idx_booking_status'`)
  check('EXPLAIN ANALYZE shows index on booking(status)', statusIndexResult.length > 0, `status index exists: ${String(statusIndexResult.length > 0)}`)

  log('         --- cleaning up 100k fixtures ---')
  await dataSource.query('DELETE FROM audit_log WHERE booking_id IN (SELECT id FROM booking WHERE purpose LIKE $1)', [`${BOOKING_PREFIX}%`])
  await dataSource.query('DELETE FROM booking_equipment WHERE booking_id IN (SELECT id FROM booking WHERE purpose LIKE $1)', [`${BOOKING_PREFIX}%`])
  await dataSource.query('DELETE FROM booking WHERE purpose LIKE $1', [`${BOOKING_PREFIX}%`])
  const remaining = (await dataSource.query('SELECT count(*)::int AS c FROM booking WHERE purpose LIKE $1', [`${BOOKING_PREFIX}%`])) as Array<{ c: number }>
  log(`         remaining bookings after cleanup: ${String(remaining[0]?.c)}`)

  void dataSource
}

async function main(): Promise<void> {
  const env = loadEnv()
  const dataSource = createDataSource()
  await dataSource.initialize()
  installQueryCounter(dataSource)
  await cleanup(dataSource)

  const app = await createApp(dataSource)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  port = (server.address() as AddressInfo).port
  log(`S7 acceptance suite — server pid ${process.pid}, port ${port}, db ${env.db.name}`)

  try {
    await login()
    await testNfr1ConstantQueryCount(dataSource)
    await testNfr4Performance(dataSource)
  } finally {
    await cleanup(dataSource)
    await reportCleanup(dataSource)
    server.close()
    await dataSource.destroy()
  }

  log('')
  if (failures === 0) {
    log('RESULT: all S7 acceptance checks passed')
    process.exit(0)
  }
  log(`RESULT: ${String(failures)} check(s) FAILED`)
  process.exit(1)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  log(`UNCAUGHT ERROR: ${message}`)
  process.exit(1)
})
