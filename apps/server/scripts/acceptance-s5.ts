import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDataSource } from '../src/config/data-source'
import { runInTransaction } from '../src/common/db/transaction'
import { AuditService, type AuditRecordInput } from '../src/modules/audit/audit.service'
import type { AuditAction } from '../src/modules/audit/audit-log.entity'
import type { BookingStatus } from '@resource-booking/shared'
import type { DataSource, EntityManager } from 'typeorm'

interface GraphQLError {
  message: string
}

interface GraphQLResponse<T> {
  data?: T
  errors?: GraphQLError[]
}

interface AuditActor {
  id: string
}

interface AuditItem {
  id: string
  bookingId: string
  action: AuditAction
  oldStatus: BookingStatus | null
  newStatus: BookingStatus
  performedById: string | null
  performedBy: AuditActor | null
  performedByName: string
  performedByDisplayName: string
  createdAt: string
}

interface AuditPage {
  totalCount: number
  items: AuditItem[]
}

interface FixtureConnectionOptions {
  host: string
  port: number
  username: string
  database: string
  password: string
}

const GRAPHQL_URL = process.env.GRAPHQL_URL ?? 'http://localhost:3000/graphql'
const PSQL = '/Library/PostgreSQL/18/bin/psql'
const schemaPath = join(__dirname, '..', 'schema.graphql')

function sql(dataSource: DataSource, statement: string): string {
  const options = dataSource.options as unknown as FixtureConnectionOptions
  const result = spawnSync(
    PSQL,
    [
      '-h',
      String(options.host),
      '-p',
      String(options.port),
      '-U',
      String(options.username),
      '-d',
      String(options.database),
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-At',
      '-c',
      statement,
    ],
    {
      env: { ...process.env, PGPASSWORD: String(options.password) },
      encoding: 'utf8',
    },
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'psql failed')
  }
  return result.stdout.trim()
}

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  token?: string,
): Promise<T> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ query, variables }),
  })
  const text = await response.text()
  const body = JSON.parse(text) as GraphQLResponse<T>
  if (!response.ok || body.errors !== undefined || body.data === undefined) {
    throw new Error(`GraphQL request failed: HTTP ${response.status} ${text}`)
  }
  return body.data
}

async function rawGraphql<T>(
  label: string,
  query: string,
  variables: Record<string, unknown>,
  token: string,
): Promise<T> {
  console.log(`\n${label}`)
  console.log(`request: ${query} variables=${JSON.stringify(variables)}`)
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  })
  const text = await response.text()
  console.log(`response: HTTP ${response.status} ${text}`)
  const body = JSON.parse(text) as GraphQLResponse<T>
  if (!response.ok || body.errors !== undefined || body.data === undefined) {
    throw new Error(`GraphQL request failed: HTTP ${response.status} ${text}`)
  }
  return body.data
}

function auditInput(
  bookingId: string,
  performedBy: string,
  action: AuditAction,
  oldStatus: BookingStatus | null,
  newStatus: BookingStatus,
): AuditRecordInput {
  return { bookingId, action, oldStatus, newStatus, performedBy }
}

async function record(
  dataSource: DataSource,
  service: AuditService,
  input: AuditRecordInput,
): Promise<string> {
  return runInTransaction(dataSource, async (manager: EntityManager) => {
    const row = await service.record(manager, input)
    return row.id
  })
}

function assertIds(actual: AuditItem[], expected: string[], label: string): void {
  assert.equal(actual.length, expected.length, `${label}: item count`)
  assert.deepEqual(
    actual.map((item) => item.id).sort(),
    [...expected].sort(),
    `${label}: ids`,
  )
}

function checkSchemaAuditMutations(): void {
  const schema = readFileSync(schemaPath, 'utf8')
  const mutation = schema.match(/type Mutation\s*\{([\s\S]*?)\n\}/)
  assert.ok(mutation, 'schema.graphql must contain a Mutation type')
  const mutationBody = mutation?.[1]
  assert.ok(mutationBody, 'schema.graphql Mutation type must have a body')
  const lines = mutationBody
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(line))
  const auditMutationFields = lines.filter((line) => /audit/i.test(line))
  console.log('\nTEST 7 — zero AuditLog mutation fields in schema.graphql')
  console.log(`request: ${schemaPath}`)
  console.log(`response: mutation fields matching /audit/i = ${JSON.stringify(auditMutationFields)}`)
  assert.deepEqual(auditMutationFields, [])
}

async function cleanup(
  dataSource: DataSource,
  employeeId: string | undefined,
  roomId: string | undefined,
  bookingId: string | undefined,
): Promise<void> {
  if (bookingId !== undefined) {
    sql(dataSource, `DELETE FROM audit_log WHERE booking_id = '${bookingId}';`)
    sql(dataSource, `DELETE FROM booking WHERE id = '${bookingId}';`)
  }
  if (roomId !== undefined) {
    sql(dataSource, `DELETE FROM meeting_room WHERE id = '${roomId}';`)
  }
  if (employeeId !== undefined) {
    sql(dataSource, `DELETE FROM employee WHERE id = '${employeeId}';`)
  }
  const ids = {
    employee: employeeId ?? '',
    room: roomId ?? '',
    booking: bookingId ?? '',
  }
  const statement = `SELECT (SELECT count(*) FROM employee WHERE id = '${ids.employee}') AS fixture_employee, (SELECT count(*) FROM meeting_room WHERE id = '${ids.room}') AS fixture_room, (SELECT count(*) FROM booking WHERE id = '${ids.booking}') AS fixture_booking, (SELECT count(*) FROM audit_log WHERE booking_id = '${ids.booking}') AS fixture_audit;`
  const request = `psql -c "${statement}"`
  const response = sql(dataSource, statement)
  console.log('\nCLEANUP — S5 fixture row counts')
  console.log(`request: ${request}`)
  console.log(`response: ${response}`)
  const [employeeCount, roomCount, bookingCount, auditCount] = response.split('|').map(Number)
  assert.deepEqual(
    { fixture_employee: employeeCount, fixture_room: roomCount, fixture_booking: bookingCount, fixture_audit: auditCount },
    { fixture_employee: 0, fixture_room: 0, fixture_booking: 0, fixture_audit: 0 },
  )
}

async function main(): Promise<void> {
  const dataSource = await createDataSource()
  await dataSource.initialize()
  const service = new AuditService()
  let employeeId: string | undefined
  let roomId: string | undefined
  let bookingId: string | undefined
  let runError: unknown

  try {
    const adminEmail = process.env.ADMIN_EMAIL
    const adminPassword = process.env.ADMIN_PASSWORD
    assert.ok(adminEmail, 'ADMIN_EMAIL is required')
    assert.ok(adminPassword, 'ADMIN_PASSWORD is required')

    const login = await graphql<{ login: string }>(
      'mutation Login($input: LoginInput!) { login(input: $input) }',
      { input: { email: adminEmail, password: adminPassword } },
    )
    const token = login.login
    console.log(`S5 acceptance — server ${GRAPHQL_URL}, db ${String((dataSource.options as unknown as FixtureConnectionOptions).database)}`)

    const employee = await graphql<{ createEmployee: { id: string } }>(
      'mutation CreateEmployee($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }',
      {
        input: {
          firstName: 'S5',
          lastName: 'Fixture',
          email: `s5.fixture.${Date.now()}@example.test`,
          password: 'S5Fixture!123',
        },
      },
      token,
    )
    employeeId = employee.createEmployee.id

    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const roomStatement = `INSERT INTO meeting_room (name, location, capacity) VALUES ('S5 fixture room ${suffix}', 'S5 fixture', 1) RETURNING id;`
    roomId = sql(dataSource, roomStatement)
    const bookingStatement = `INSERT INTO booking (room_id, start_time, end_time, purpose, number_of_attendees, status) VALUES ('${roomId}', now() + interval '1 day', now() + interval '1 day 1 hour', 'S5 fixture ${suffix}', 1, 'PENDING') RETURNING id;`
    bookingId = sql(dataSource, bookingStatement)
    console.log(`fixture: employee=${employeeId} room=${roomId} booking=${bookingId}`)

    const dateFrom = new Date(Date.now() - 60_000).toISOString()
    const rollbackInput = auditInput(bookingId, employeeId, 'CREATE', null, 'PENDING')
    let rollbackThrown = false
    try {
      await runInTransaction(dataSource, async (manager) => {
        await service.record(manager, rollbackInput)
        throw new Error('forced S5 audit rollback')
      })
    } catch (error) {
      rollbackThrown = error instanceof Error && error.message === 'forced S5 audit rollback'
    }
    assert.equal(rollbackThrown, true, 'rollback transaction did not throw as expected')
    const rollbackCount = Number(sql(dataSource, `SELECT count(*) FROM audit_log WHERE booking_id = '${bookingId}';`))
    assert.equal(rollbackCount, 0)
    console.log(`\nTEST 9 — transaction rollback`)
    console.log(`request: AuditService.record(${JSON.stringify(rollbackInput)}); throw forced S5 audit rollback`)
    console.log(`response: rollback observed=true, durable audit_log rows=${rollbackCount}`)

    const committedInputs: AuditRecordInput[] = [
      auditInput(bookingId, employeeId, 'CREATE', null, 'PENDING'),
      auditInput(bookingId, employeeId, 'APPROVE', 'PENDING', 'APPROVED'),
      auditInput(bookingId, employeeId, 'REJECT', 'PENDING', 'REJECTED'),
      auditInput(bookingId, employeeId, 'COMPLETE', 'APPROVED', 'COMPLETED'),
    ]
    const committedIds: string[] = []
    for (const input of committedInputs) {
      committedIds.push(await record(dataSource, service, input))
    }
    const dateTo = new Date(Date.now() + 60_000).toISOString()
    const commitCount = Number(sql(dataSource, `SELECT count(*) FROM audit_log WHERE booking_id = '${bookingId}';`))
    assert.equal(commitCount, committedIds.length)
    console.log(`response: commit observed=true, durable audit_log rows=${commitCount}`)
    console.log(`committed audit ids: ${JSON.stringify(committedIds)}`)

    const fields = 'id bookingId action oldStatus newStatus performedById performedBy { id } performedByName performedByDisplayName createdAt'
    const bookingQuery = `query AuditByBooking($bookingId: ID!, $page: Int!, $pageSize: Int!) { auditLogs(bookingId: $bookingId, page: $page, pageSize: $pageSize) { totalCount items { ${fields} } } }`
    const bookingResult = await rawGraphql<{ auditLogs: AuditPage }>(
      'TEST 1 — search audit log by booking id',
      bookingQuery,
      { bookingId, page: 1, pageSize: 20 },
      token,
    )
    assert.equal(bookingResult.auditLogs.totalCount, committedIds.length)
    assertIds(bookingResult.auditLogs.items, committedIds, 'booking filter')

    const actorQuery = `query AuditByActor($actorId: ID!, $page: Int!, $pageSize: Int!) { auditLogs(actorId: $actorId, page: $page, pageSize: $pageSize) { totalCount items { ${fields} } } }`
    const actorResult = await rawGraphql<{ auditLogs: AuditPage }>(
      'TEST 2 — search audit log by actor (employee id)',
      actorQuery,
      { actorId: employeeId, page: 1, pageSize: 20 },
      token,
    )
    assert.equal(actorResult.auditLogs.totalCount, committedIds.length)
    assertIds(actorResult.auditLogs.items, committedIds, 'actor filter')

    const actionQuery = `query AuditByAction($action: AuditAction!, $page: Int!, $pageSize: Int!) { auditLogs(action: $action, page: $page, pageSize: $pageSize) { totalCount items { ${fields} } } }`
    const approveResult = await rawGraphql<{ auditLogs: AuditPage }>(
      'TEST 3 — search audit log by action',
      actionQuery,
      { action: 'APPROVE', page: 1, pageSize: 20 },
      token,
    )
    assert.equal(approveResult.auditLogs.totalCount, 1)
    assert.equal(approveResult.auditLogs.items[0]?.id, committedIds[1])
    assert.equal(approveResult.auditLogs.items[0]?.action, 'APPROVE')

    const statusQuery = `query AuditByStatus($status: BookingStatus!, $page: Int!, $pageSize: Int!) { auditLogs(status: $status, page: $page, pageSize: $pageSize) { totalCount items { ${fields} } } }`
    const approvedResult = await rawGraphql<{ auditLogs: AuditPage }>(
      'TEST 4a — search by new status APPROVED (shows old PENDING)',
      statusQuery,
      { status: 'APPROVED', page: 1, pageSize: 20 },
      token,
    )
    assert.equal(approvedResult.auditLogs.totalCount, 1)
    assert.equal(approvedResult.auditLogs.items[0]?.oldStatus, 'PENDING')
    assert.equal(approvedResult.auditLogs.items[0]?.newStatus, 'APPROVED')
    const pendingResult = await rawGraphql<{ auditLogs: AuditPage }>(
      'TEST 4b — search by new status PENDING (shows old null)',
      statusQuery,
      { status: 'PENDING', page: 1, pageSize: 20 },
      token,
    )
    assert.equal(pendingResult.auditLogs.totalCount, 1)
    assert.equal(pendingResult.auditLogs.items[0]?.oldStatus, null)
    assert.equal(pendingResult.auditLogs.items[0]?.newStatus, 'PENDING')

    const dateQuery = `query AuditByDate($from: DateTimeISO!, $to: DateTimeISO!, $page: Int!, $pageSize: Int!) { auditLogs(from: $from, to: $to, page: $page, pageSize: $pageSize) { totalCount items { ${fields} } } }`
    const dateResult = await rawGraphql<{ auditLogs: AuditPage }>(
      'TEST 5 — search audit log by date range',
      dateQuery,
      { from: dateFrom, to: dateTo, page: 1, pageSize: 20 },
      token,
    )
    assert.equal(dateResult.auditLogs.totalCount, committedIds.length)
    assertIds(dateResult.auditLogs.items, committedIds, 'date filter')

    const pageQuery = `query AuditPage($bookingId: ID!, $page: Int!, $pageSize: Int!) { auditLogs(bookingId: $bookingId, page: $page, pageSize: $pageSize) { totalCount items { id createdAt } } }`
    const pageOne = await rawGraphql<{ auditLogs: AuditPage }>(
      'TEST 6a — pagination page 1 of 2, pageSize 2',
      pageQuery,
      { bookingId, page: 1, pageSize: 2 },
      token,
    )
    const pageTwo = await rawGraphql<{ auditLogs: AuditPage }>(
      'TEST 6b — pagination page 2 of 2, pageSize 2',
      pageQuery,
      { bookingId, page: 2, pageSize: 2 },
      token,
    )
    assert.equal(pageOne.auditLogs.totalCount, committedIds.length)
    assert.equal(pageTwo.auditLogs.totalCount, committedIds.length)
    assert.equal(pageOne.auditLogs.items.length, 2)
    assert.equal(pageTwo.auditLogs.items.length, 2)
    assert.equal(new Set([...pageOne.auditLogs.items, ...pageTwo.auditLogs.items].map((item) => item.id)).size, committedIds.length)

    checkSchemaAuditMutations()

    const deleted = await rawGraphql<{ deleteEmployee: boolean }>(
      'SETUP — delete fixture employee for fallback check',
      'mutation DeleteEmployee($id: String!) { deleteEmployee(id: $id) }',
      { id: employeeId },
      token,
    )
    assert.equal(deleted.deleteEmployee, true)
    const fallbackResult = await rawGraphql<{ auditLogs: AuditPage }>(
      'TEST 8 — Deleted user fallback after employee deletion',
      bookingQuery,
      { bookingId, page: 1, pageSize: 20 },
      token,
    )
    assert.equal(fallbackResult.auditLogs.totalCount, committedIds.length)
    for (const item of fallbackResult.auditLogs.items) {
      assert.equal(item.performedById, null)
      assert.equal(item.performedBy, null)
      assert.equal(item.performedByName, 'Deleted user')
      assert.equal(item.performedByDisplayName, 'Deleted user')
    }
    console.log('TEST 9 — transaction commit')
    console.log(`response: commit observed=true, durable audit_log rows=${commitCount}`)
  } catch (error) {
    runError = error
    console.error(`S5 acceptance failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  } finally {
    try {
      await cleanup(dataSource, employeeId, roomId, bookingId)
    } catch (error) {
      console.error(`S5 cleanup failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      if (runError === undefined) {
        runError = error
      }
    }
    await dataSource.destroy()
  }

  if (runError !== undefined) {
    throw runError
  }
  console.log('\nRESULT: all S5 acceptance checks passed')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
