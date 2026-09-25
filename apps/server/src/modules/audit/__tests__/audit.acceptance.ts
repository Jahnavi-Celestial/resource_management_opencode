import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createDataSource } from '../../../config/data-source'
import { runInTransaction } from '../../../common/db/transaction'
import { AuditService, type AuditRecordInput } from '../audit.service'
import type { AuditAction } from '../audit-log.entity'
import type { BookingStatus } from '@resource-booking/shared'
import type { DataSource } from 'typeorm'

interface GraphQLError {
  message: string
}

interface GraphQLResponse<T> {
  data?: T
  errors?: GraphQLError[]
}

interface AuditItem {
  id: string
  performedById: string | null
  performedBy: { id: string } | null
  performedByName: string
  performedByDisplayName: string
}

const GRAPHQL_URL = 'http://localhost:3000/graphql'
const PSQL = '/Library/PostgreSQL/18/bin/psql'

interface FixtureConnectionOptions {
  host: string
  port: number
  username: string
  database: string
  password: string
}

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
  const body = (await response.json()) as GraphQLResponse<T>
  if (body.errors !== undefined) {
    throw new Error(body.errors.map((error) => error.message).join('; '))
  }
  if (body.data === undefined) {
    throw new Error(`GraphQL returned no data (${response.status})`)
  }
  return body.data
}

function auditInput(
  bookingId: string,
  performedBy: string,
  action: AuditAction,
  newStatus: BookingStatus,
): AuditRecordInput {
  return {
    bookingId,
    action,
    oldStatus: null,
    newStatus,
    performedBy,
  }
}

async function main(): Promise<void> {
  const dataSource = await createDataSource()
  await dataSource.initialize()
  const service = new AuditService()
  let roomId: string | undefined
  let bookingId: string | undefined
  let employeeId: string | undefined
  let employeeDeleted = false

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

    const employee = await graphql<{ createEmployee: { id: string; email: string } }>(
      'mutation CreateEmployee($input: CreateEmployeeInput!) { createEmployee(input: $input) { id email } }',
      {
        input: {
          firstName: 'Audit',
          lastName: 'Fixture',
          email: `audit.fixture.${Date.now()}@example.test`,
          password: 'AuditFixture!123',
        },
      },
      token,
    )
    employeeId = employee.createEmployee.id

    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    roomId = sql(
      dataSource,
      `INSERT INTO meeting_room (name, location, capacity) VALUES ('Audit fixture room ${suffix}', 'Audit fixture', 1) RETURNING id;`,
    )
    bookingId = sql(
      dataSource,
      `INSERT INTO booking (room_id, start_time, end_time, purpose, number_of_attendees, status) VALUES ('${roomId}', now() + interval '1 day', now() + interval '1 day 1 hour', 'Audit fixture ${suffix}', 1, 'PENDING') RETURNING id;`,
    )
    console.log(`fixture: room=${roomId} booking=${bookingId}`)

    let forcedRollback = false
    try {
      await runInTransaction(dataSource, async (manager) => {
        await service.record(manager, auditInput(bookingId!, employeeId!, 'CREATE', 'PENDING'))
        throw new Error('forced audit rollback')
      })
    } catch (error) {
      forcedRollback = error instanceof Error && error.message === 'forced audit rollback'
    }
    assert.equal(forcedRollback, true, 'rollback transaction did not throw as expected')
    const rollbackCount = Number(sql(dataSource, `SELECT count(*) FROM audit_log WHERE booking_id = '${bookingId}';`))
    assert.equal(rollbackCount, 0)
    console.log(`rollback: audit_log rows=${rollbackCount}`)

    let committedAuditId = ''
    await runInTransaction(dataSource, async (manager) => {
      const row = await service.record(manager, auditInput(bookingId!, employeeId!, 'CREATE', 'PENDING'))
      committedAuditId = row.id
    })
    const commitCount = Number(sql(dataSource, `SELECT count(*) FROM audit_log WHERE booking_id = '${bookingId}';`))
    assert.equal(commitCount, 1)
    assert.ok(committedAuditId)
    console.log(`commit: audit_log rows=${commitCount}`)

    let fallbackAuditId = ''
    await runInTransaction(dataSource, async (manager) => {
      const row = await service.record(manager, auditInput(bookingId!, employeeId!, 'APPROVE', 'APPROVED'))
      fallbackAuditId = row.id
    })

    const deleted = await graphql<{ deleteEmployee: boolean }>(
      'mutation DeleteEmployee($id: String!) { deleteEmployee(id: $id) }',
      { id: employeeId },
      token,
    )
    assert.equal(deleted.deleteEmployee, true)
    employeeDeleted = true

    const result = await graphql<{ auditLogs: { items: AuditItem[] } }>(
      `query AuditLogs($bookingId: ID!) {
        auditLogs(page: 1, pageSize: 20, filter: { bookingId: $bookingId }) {
          items { id performedById performedBy { id } performedByName performedByDisplayName }
        }
      }`,
      { bookingId },
      token,
    )
    const fallback = result.auditLogs.items.find((item) => item.id === fallbackAuditId)
    assert.ok(fallback)
    assert.equal(fallback.performedById, null)
    assert.equal(fallback.performedBy, null)
    assert.equal(fallback.performedByName, 'Deleted user')
    assert.equal(fallback.performedByDisplayName, 'Deleted user')
    assert.equal(result.auditLogs.items.find((item) => item.id === committedAuditId)?.performedById, null)
    console.log(`deleted-user: performedBy=${JSON.stringify(fallback.performedBy)} performedByDisplayName=${JSON.stringify(fallback.performedByDisplayName)}`)
  } finally {
    if (bookingId !== undefined) {
      sql(dataSource, `DELETE FROM audit_log WHERE booking_id = '${bookingId}';`)
      sql(dataSource, `DELETE FROM booking WHERE id = '${bookingId}';`)
    }
    if (roomId !== undefined) {
      sql(dataSource, `DELETE FROM meeting_room WHERE id = '${roomId}';`)
    }
    if (employeeId !== undefined && !employeeDeleted) {
      try {
        const login = await graphql<{ login: string }>(
          'mutation Login($input: LoginInput!) { login(input: $input) }',
          { input: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } },
        )
        await graphql<{ deleteEmployee: boolean }>(
          'mutation DeleteEmployee($id: String!) { deleteEmployee(id: $id) }',
          { id: employeeId },
          login.login,
        )
      } catch {
        sql(dataSource, `DELETE FROM employee WHERE id = '${employeeId}';`)
      }
    }
    await dataSource.destroy()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
