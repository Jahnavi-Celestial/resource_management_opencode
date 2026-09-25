import 'reflect-metadata'
import type { AddressInfo } from 'node:net'
import { Like, type DataSource, type DataSourceOptions, type Logger as TypeOrmLogger, type QueryRunner } from 'typeorm'
import { loadEnv } from '../src/config/env'
import { createDataSource } from '../src/config/data-source'
import { createApp } from '../src/app'
import { Employee } from '../src/modules/employee/employee.entity'
import { SYSTEM_EMPLOYEE_EMAIL } from '../src/modules/employee/system-account'

const FIXTURE_PREFIX = 's4.fixture.'
const NFR_PREFIX = 's4.nfr.'
const ROOM_PREFIX = 'S4 '
const EQUIPMENT_PREFIX = 'S4 '
const PASSWORD = 'S4Fixture@2026'
const NFR_EMPLOYEE_COUNT = 20

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

interface RoleItem {
  id: string
  roleName: string
}

interface EmployeeItem {
  id: string
  firstName: string
  lastName: string
  email: string
  roles?: RoleItem[]
}

interface RoomItem {
  id: string
  name: string
  location: string
  capacity: number
  isActive: boolean
}

interface EquipmentItem {
  id: string
  name: string
  quantityAvailable: number
  isActive: boolean
}

interface Page<T> {
  items: T[]
  totalCount: number
}

let port = 0
let failures = 0
let token = ''
let captureQueries = false
const capturedQueries: CapturedQuery[] = []

function log(line: string): void {
  console.log(line)
}

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

async function show(query: string, authenticated = true): Promise<GqlResult> {
  const result = await gql(query, authenticated)
  log(`         request:  ${query}`)
  log(`         response: HTTP ${result.status} ${JSON.stringify(result.body)}`)
  return result
}

function dataOf(result: GqlResult): Record<string, unknown> {
  return (result.body.data ?? {}) as Record<string, unknown>
}

function firstError(result: GqlResult): GqlError | undefined {
  return result.body.errors?.[0]
}

function errorCode(result: GqlResult): string {
  const code = firstError(result)?.extensions?.code
  return typeof code === 'string' ? code : '<none>'
}

function fieldErrorsOf(result: GqlResult): Array<{ field: string; message: string }> {
  const raw = firstError(result)?.extensions?.fieldErrors
  return Array.isArray(raw) ? (raw as Array<{ field: string; message: string }>) : []
}

function pageOf<T>(result: GqlResult, key: string): Page<T> {
  const value = dataOf(result)[key]
  if (value === undefined || value === null) return { items: [], totalCount: 0 }
  const page = value as { items?: T[]; totalCount?: number }
  return { items: page.items ?? [], totalCount: page.totalCount ?? 0 }
}

function entityOf<T>(result: GqlResult, key: string): T | undefined {
  const value = dataOf(result)[key]
  return value === undefined || value === null ? undefined : (value as T)
}

function isDescending<T>(values: T[], compare: (left: T, right: T) => number): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1] as T, value) >= 0)
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

async function test1DuplicateEmail(): Promise<string> {
  log('')
  log('TEST 1 — duplicate employee email is a field-level validation error, never a 500')
  const email = `${FIXTURE_PREFIX}dup@resource.local`
  const first = await show(
    `mutation { createEmployee(input: { firstName: "S4", lastName: "DupOne", email: "${email}", password: "${PASSWORD}" }) { id email } }`,
  )
  const created = entityOf<EmployeeItem>(first, 'createEmployee')
  check(
    'first createEmployee with a fresh email succeeds',
    first.status === 200 && created !== undefined && created.email === email,
    `HTTP ${first.status}, stored email=${String(created?.email)}`,
  )
  const duplicate = await show(
    `mutation { createEmployee(input: { firstName: "S4", lastName: "DupTwo", email: "${FIXTURE_PREFIX}DUP@resource.local", password: "${PASSWORD}" }) { id } }`,
  )
  const code = errorCode(duplicate)
  const fieldErrors = fieldErrorsOf(duplicate)
  check(
    'duplicate email (different case) is rejected as BAD_USER_INPUT, not a 500',
    duplicate.status !== 500 && code === 'BAD_USER_INPUT',
    `HTTP ${duplicate.status}, code=${code}, message=${String(firstError(duplicate)?.message)}`,
  )
  check(
    'the rejection is a field-level error on "email"',
    fieldErrors.length === 1 && fieldErrors[0]?.field === 'email',
    `extensions.fieldErrors=${JSON.stringify(fieldErrors)}`,
  )
  return created?.id ?? ''
}

async function test2DeleteGuards(dataSource: DataSource, employeeId: string): Promise<void> {
  log('')
  log('TEST 2 — self-delete and system-account delete are refused; deleting another employee is a genuine hard delete')
  const meResult = await show('{ me { employee { id email } } }')
  const me = entityOf<{ employee?: { id: string; email: string } }>(meResult, 'me')?.employee
  const systemRows = (await dataSource.query('SELECT id FROM employee WHERE email = $1', [
    SYSTEM_EMPLOYEE_EMAIL,
  ])) as Array<{ id: string }>
  const systemId = systemRows[0]?.id ?? ''

  if (me === undefined || systemId === '') {
    check('me query and system account row are available', false, `me=${JSON.stringify(me)}, systemId=${systemId}`)
    return
  }

  const selfDelete = await show(`mutation { deleteEmployee(id: "${me.id}") }`)
  check(
    'self-delete is refused with CONFLICT',
    errorCode(selfDelete) === 'CONFLICT',
    `code=${errorCode(selfDelete)}, message=${String(firstError(selfDelete)?.message)}`,
  )

  const systemDelete = await show(`mutation { deleteEmployee(id: "${systemId}") }`)
  check(
    `system-account delete (${SYSTEM_EMPLOYEE_EMAIL}) is refused with CONFLICT`,
    errorCode(systemDelete) === 'CONFLICT',
    `code=${errorCode(systemDelete)}, message=${String(firstError(systemDelete)?.message)}`,
  )
  const systemStillThere = (await dataSource.query('SELECT count(*)::int AS c FROM employee WHERE id = $1', [
    systemId,
  ])) as Array<{ c: number }>
  check(
    'system account row survived both refused deletes',
    (systemStillThere[0]?.c ?? 0) === 1,
    `row count for system id=${String(systemStillThere[0]?.c)}`,
  )

  const beforeDelete = (await dataSource.query('SELECT count(*)::int AS c FROM employee WHERE id = $1', [
    employeeId,
  ])) as Array<{ c: number }>
  const softDeleteColumns = (await dataSource.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'employee' AND column_name IN ('is_active', 'is_deleted', 'deleted_at', 'archived_at')",
  )) as Array<{ column_name: string }>
  const deleted = await show(`mutation { deleteEmployee(id: "${employeeId}") }`)
  const afterDelete = (await dataSource.query('SELECT count(*)::int AS c FROM employee WHERE id = $1', [
    employeeId,
  ])) as Array<{ c: number }>

  check(
    'deleting a different employee returns true',
    dataOf(deleted).deleteEmployee === true,
    `deleteEmployee=${JSON.stringify(dataOf(deleted).deleteEmployee)}, HTTP ${deleted.status}`,
  )
  check(
    'the row is gone from the table (hard delete, row count 1 -> 0)',
    (beforeDelete[0]?.c ?? 0) === 1 && (afterDelete[0]?.c ?? 0) === 0,
    `SELECT count(*) before=${String(beforeDelete[0]?.c)} after=${String(afterDelete[0]?.c)}`,
  )
  check(
    'the employee table has no soft-delete/flag column, so "gone" cannot mean "soft-flagged"',
    softDeleteColumns.length === 0,
    `information_schema soft-delete columns on employee=${JSON.stringify(softDeleteColumns)}`,
  )
  const lookupAfterDelete = await show(`{ employee(id: "${employeeId}") { id email } }`)
  check(
    'the deleted id now returns NOT_FOUND through the API',
    errorCode(lookupAfterDelete) === 'NOT_FOUND',
    `code=${errorCode(lookupAfterDelete)}, message=${String(firstError(lookupAfterDelete)?.message)}`,
  )
}

async function test3Nfr1ConstantQueryCount(dataSource: DataSource): Promise<void> {
  log('')
  log('TEST 3 — NFR-1: listing employees WITH roles resolved stays at a constant SQL query count regardless of row count')
  const roleRows = (await dataSource.query("SELECT id FROM role WHERE role_name = 'Employee'")) as Array<{
    id: string
  }>
  const employeeRoleId = roleRows[0]?.id
  if (employeeRoleId === undefined) {
    check('seeded Employee role exists', false, 'run npm run seed first')
    return
  }
  const ids: string[] = []
  for (let index = 1; index <= NFR_EMPLOYEE_COUNT; index += 1) {
    const suffix = String(index).padStart(2, '0')
    const created = await gql(
      `mutation { createEmployee(input: { firstName: "Nfr", lastName: "Load${suffix}", email: "${NFR_PREFIX}${suffix}@resource.local", password: "${PASSWORD}" }) { id email lastName } }`,
    )
    const employee = entityOf<EmployeeItem>(created, 'createEmployee')
    if (employee === undefined) {
      throw new Error(`failed to seed NFR employee ${suffix}: ${JSON.stringify(created.body)}`)
    }
    ids.push(employee.id)
  }
  let assigned = 0
  for (const employeeId of ids) {
    const result = await gql(
      `mutation { assignRoleToEmployee(input: { employeeId: "${employeeId}", roleId: "${employeeRoleId}" }) { id } }`,
    )
    if (entityOf<EmployeeItem>(result, 'assignRoleToEmployee') !== undefined) assigned += 1
  }
  check(
    `seeded ${String(NFR_EMPLOYEE_COUNT)} employees, all with the Employee role assigned`,
    ids.length === NFR_EMPLOYEE_COUNT && assigned === NFR_EMPLOYEE_COUNT,
    `created=${String(ids.length)}, role assignments=${String(assigned)}`,
  )

  const listWithRoles = `query { employees(search: "${NFR_PREFIX}", pageSize: PAGE, sort: { field: "email", direction: "ASC" }) { totalCount items { id email roles { id roleName } } } }`

  captureQueries = true
  capturedQueries.length = 0
  const smallResult = await gql(listWithRoles.replace('PAGE', '5'))
  const smallQueries = capturedQueries.slice()
  capturedQueries.length = 0
  const largeResult = await gql(listWithRoles.replace('PAGE', '20'))
  const largeQueries = capturedQueries.slice()
  captureQueries = false

  const smallPage = pageOf<EmployeeItem>(smallResult, 'employees')
  const largePage = pageOf<EmployeeItem>(largeResult, 'employees')

  log('         --- request A: pageSize 5, roles selected ---')
  smallQueries.forEach((query, index) => {
    log(`         SQL[${String(index + 1)}] params=${String(query.paramCount)} ${query.sql}`)
  })
  log('         --- request B: pageSize 20, roles selected ---')
  largeQueries.forEach((query, index) => {
    log(`         SQL[${String(index + 1)}] params=${String(query.paramCount)} ${query.sql}`)
  })

  check(
    'request A returns 5 rows, each with its Employee role resolved through the loader',
    smallPage.items.length === 5 && smallPage.items.every((item) => item.roles?.length === 1),
    `items=${String(smallPage.items.length)}, roles per item=${JSON.stringify(smallPage.items.map((item) => item.roles?.length ?? -1))}, totalCount=${String(smallPage.totalCount)}`,
  )
  check(
    'request B returns all 20 seeded rows, each with its Employee role resolved through the loader',
    largePage.items.length === 20 && largePage.totalCount === 20 && largePage.items.every((item) => item.roles?.length === 1),
    `items=${String(largePage.items.length)}, roles per item=${JSON.stringify(largePage.items.map((item) => item.roles?.[0]?.roleName ?? '<none>'))}`,
  )
  check(
    'total SQL query count is identical for 5 rows and 20 rows (constant, not linear)',
    smallQueries.length === largeQueries.length,
    `pageSize 5 => ${String(smallQueries.length)} queries, pageSize 20 => ${String(largeQueries.length)} queries`,
  )

  const roleBatchQueries = (queries: CapturedQuery[]): CapturedQuery[] =>
    queries.filter((query) => /user_role/i.test(query.sql) && /role/i.test(query.sql))
  const smallRoleBatches = roleBatchQueries(smallQueries)
  const largeRoleBatches = roleBatchQueries(largeQueries)
  const smallBatched = smallRoleBatches.filter((query) => query.paramCount === 5)
  const largeBatched = largeRoleBatches.filter((query) => query.paramCount === 20)
  check(
    'the 5-row page resolved all 5 employees\' roles in exactly ONE batched user_role query (not 5)',
    smallBatched.length === 1,
    `user_role queries on page A: ${JSON.stringify(smallRoleBatches.map((query) => query.paramCount))} params each`,
  )
  check(
    'the 20-row page resolved all 20 employees\' roles in exactly ONE batched user_role query (not 20)',
    largeBatched.length === 1,
    `user_role queries on page B: ${JSON.stringify(largeRoleBatches.map((query) => query.paramCount))} params each`,
  )
  check(
    '4x the rows added 0 SQL queries — the only difference is the batched IN-list length',
    largeQueries.length - smallQueries.length === 0 && (largeBatched[0]?.paramCount ?? 0) === 20,
    `query delta=${String(largeQueries.length - smallQueries.length)}, batched role params A=${String(smallBatched[0]?.paramCount)} B=${String(largeBatched[0]?.paramCount)}`,
  )
  void dataSource
}

async function test4RoomLifecycle(): Promise<RoomItem[]> {
  log('')
  log('TEST 4 — Room: create, deactivate, excluded from activeOnly-filtered list but still present in the full list')
  const focus = await show(
    `mutation { createRoom(input: { name: "${ROOM_PREFIX}Focus Room", capacity: 10, location: "${ROOM_PREFIX}North Wing" }) { id name capacity location isActive } }`,
  )
  const board = await show(
    `mutation { createRoom(input: { name: "${ROOM_PREFIX}Board Room", capacity: 20, location: "${ROOM_PREFIX}South Wing" }) { id name capacity location isActive } }`,
  )
  const focusRoom = entityOf<RoomItem>(focus, 'createRoom')
  const boardRoom = entityOf<RoomItem>(board, 'createRoom')
  if (focusRoom === undefined || boardRoom === undefined) {
    check('both S4 rooms created', false, `focus=${JSON.stringify(focus.body)}, board=${JSON.stringify(board.body)}`)
    return []
  }
  check(
    'both S4 rooms are created with isActive: true by default',
    focusRoom.isActive === true && boardRoom.isActive === true && focusRoom.capacity === 10 && boardRoom.capacity === 20,
    `focus=${JSON.stringify(focusRoom)}, board=${JSON.stringify(boardRoom)}`,
  )

  const deactivated = await show(
    `mutation { updateRoom(input: { id: "${focusRoom.id}", isActive: false }) { id name isActive updatedAt } }`,
  )
  const updated = entityOf<RoomItem>(deactivated, 'updateRoom')
  check(
    'updateRoom(isActive: false) deactivates the focus room (no delete operation exists)',
    updated?.isActive === false,
    `updateRoom=${JSON.stringify(updated)}`,
  )

  const activeOnly = await show(`{ rooms(search: "${ROOM_PREFIX}", activeOnly: true) { totalCount items { id name isActive } } }`)
  const allRooms = await show(`{ rooms(search: "${ROOM_PREFIX}") { totalCount items { id name isActive } } }`)
  const activePage = pageOf<RoomItem>(activeOnly, 'rooms')
  const allPage = pageOf<RoomItem>(allRooms, 'rooms')
  check(
    'activeOnly: true list EXCLUDES the deactivated room',
    !activePage.items.some((room) => room.id === focusRoom.id) && activePage.items.every((room) => room.isActive),
    `activeOnly totalCount=${String(activePage.totalCount)}, items=${JSON.stringify(activePage.items)}`,
  )
  check(
    'unfiltered list still CONTAINS the deactivated room, flagged isActive: false',
    allPage.items.some((room) => room.id === focusRoom.id) && allPage.items.length === 2,
    `unfiltered totalCount=${String(allPage.totalCount)}, items=${JSON.stringify(allPage.items)}`,
  )
  return [focusRoom, boardRoom]
}

async function test5EquipmentLifecycle(): Promise<EquipmentItem[]> {
  log('')
  log('TEST 5 — Equipment: create, deactivate, excluded from activeOnly-filtered list but still present in the full list')
  const projector = await show(
    `mutation { createEquipment(input: { name: "${EQUIPMENT_PREFIX}Projector", quantityAvailable: 6 }) { id name quantityAvailable isActive } }`,
  )
  const whiteboard = await show(
    `mutation { createEquipment(input: { name: "${EQUIPMENT_PREFIX}Whiteboard", quantityAvailable: 3 }) { id name quantityAvailable isActive } }`,
  )
  const projectorItem = entityOf<EquipmentItem>(projector, 'createEquipment')
  const whiteboardItem = entityOf<EquipmentItem>(whiteboard, 'createEquipment')
  if (projectorItem === undefined || whiteboardItem === undefined) {
    check('both S4 equipment items created', false, `projector=${JSON.stringify(projector.body)}, whiteboard=${JSON.stringify(whiteboard.body)}`)
    return []
  }
  check(
    'both S4 equipment items are created with isActive: true by default',
    projectorItem.isActive === true && whiteboardItem.isActive === true && projectorItem.quantityAvailable === 6,
    `projector=${JSON.stringify(projectorItem)}, whiteboard=${JSON.stringify(whiteboardItem)}`,
  )

  const deactivated = await show(
    `mutation { updateEquipment(input: { id: "${projectorItem.id}", isActive: false }) { id name isActive } }`,
  )
  const updated = entityOf<EquipmentItem>(deactivated, 'updateEquipment')
  check(
    'updateEquipment(isActive: false) deactivates the projector (no delete operation exists)',
    updated?.isActive === false,
    `updateEquipment=${JSON.stringify(updated)}`,
  )

  const activeOnly = await show(`{ equipment(search: "${EQUIPMENT_PREFIX}", activeOnly: true) { totalCount items { id name isActive } } }`)
  const allItems = await show(`{ equipment(search: "${EQUIPMENT_PREFIX}") { totalCount items { id name isActive } } }`)
  const activePage = pageOf<EquipmentItem>(activeOnly, 'equipment')
  const allPage = pageOf<EquipmentItem>(allItems, 'equipment')
  check(
    'activeOnly: true list EXCLUDES the deactivated item',
    !activePage.items.some((item) => item.id === projectorItem.id) && activePage.items.every((item) => item.isActive),
    `activeOnly totalCount=${String(activePage.totalCount)}, items=${JSON.stringify(activePage.items)}`,
  )
  check(
    'unfiltered list still CONTAINS the deactivated item, flagged isActive: false',
    allPage.items.some((item) => item.id === projectorItem.id) && allPage.items.length === 2,
    `unfiltered totalCount=${String(allPage.totalCount)}, items=${JSON.stringify(allPage.items)}`,
  )
  return [projectorItem, whiteboardItem]
}

async function test6SearchAndSort(): Promise<void> {
  log('')
  log('TEST 6 — search and sort on all three modules')

  const byName = await show(
    `{ employees(search: "Load07", sort: { field: "email", direction: "ASC" }) { totalCount items { id lastName email } } }`,
  )
  const namePage = pageOf<EmployeeItem>(byName, 'employees')
  check(
    'employee search matches by name (lastName "Load07")',
    namePage.items.length === 1 && namePage.items[0]?.lastName === 'Load07',
    `totalCount=${String(namePage.totalCount)}, items=${JSON.stringify(namePage.items.map((item) => `${item.lastName} <${item.email}>`))}`,
  )

  const byEmail = await show(
    `{ employees(search: "${NFR_PREFIX}13@resource.local", sort: { field: "email", direction: "ASC" }) { totalCount items { id email } } }`,
  )
  const emailPage = pageOf<EmployeeItem>(byEmail, 'employees')
  check(
    'employee search matches by email (full "s4.nfr.13@resource.local")',
    emailPage.items.length === 1 && emailPage.items[0]?.email === `${NFR_PREFIX}13@resource.local`,
    `totalCount=${String(emailPage.totalCount)}, items=${JSON.stringify(emailPage.items)}`,
  )

  const employeesDesc = await show(
    `{ employees(search: "${NFR_PREFIX}", sort: { field: "lastName", direction: "DESC" }) { totalCount items { lastName } } }`,
  )
  const lastNames = pageOf<EmployeeItem>(employeesDesc, 'employees').items.map((item) => item.lastName)
  check(
    'employee sort lastName DESC returns 20 rows in descending order',
    lastNames.length === 20 && isDescending(lastNames, (left, right) => (left > right ? 1 : left < right ? -1 : 0)),
    `first 4=${JSON.stringify(lastNames.slice(0, 4))}, last 2=${JSON.stringify(lastNames.slice(-2))}`,
  )

  const employeesAsc = await show(
    `{ employees(search: "${NFR_PREFIX}", sort: { field: "lastName", direction: "ASC" }) { items { lastName } } }`,
  )
  const ascNames = pageOf<EmployeeItem>(employeesAsc, 'employees').items.map((item) => item.lastName)
  check(
    'employee sort lastName ASC is the exact reverse ordering',
    ascNames.length === 20 && isDescending(ascNames, (left, right) => (left < right ? 1 : left > right ? -1 : 0)),
    `first 4=${JSON.stringify(ascNames.slice(0, 4))}, last 2=${JSON.stringify(ascNames.slice(-2))}`,
  )

  const roomByName = await show(`{ rooms(search: "Focus") { totalCount items { name location } } }`)
  const roomNamePage = pageOf<RoomItem>(roomByName, 'rooms')
  check(
    'room search matches by name ("Focus")',
    roomNamePage.items.length === 1 && roomNamePage.items[0]?.name === `${ROOM_PREFIX}Focus Room`,
    `totalCount=${String(roomNamePage.totalCount)}, items=${JSON.stringify(roomNamePage.items)}`,
  )

  const roomByLocation = await show(`{ rooms(search: "South Wing") { totalCount items { name location } } }`)
  const roomLocationPage = pageOf<RoomItem>(roomByLocation, 'rooms')
  check(
    'room search matches by location ("South Wing")',
    roomLocationPage.items.length === 1 && roomLocationPage.items[0]?.name === `${ROOM_PREFIX}Board Room`,
    `totalCount=${String(roomLocationPage.totalCount)}, items=${JSON.stringify(roomLocationPage.items)}`,
  )

  const roomByCapacity = await show(`{ rooms(minCapacity: 15) { totalCount items { name capacity } } }`)
  const roomCapacityPage = pageOf<RoomItem>(roomByCapacity, 'rooms')
  check(
    'room minCapacity: 15 returns only rooms with capacity >= 15',
    roomCapacityPage.items.length > 0 && roomCapacityPage.items.every((room) => room.capacity >= 15),
    `totalCount=${String(roomCapacityPage.totalCount)}, items=${JSON.stringify(roomCapacityPage.items)}`,
  )

  const roomsByCapacitySort = await show(
    `{ rooms(sort: { field: "capacity", direction: "DESC" }) { totalCount items { name capacity } } }`,
  )
  const capacities = pageOf<RoomItem>(roomsByCapacitySort, 'rooms').items.map((room) => room.capacity)
  check(
    'room sort capacity DESC returns rows in descending capacity order',
    capacities.length > 0 && isDescending(capacities, (left, right) => left - right),
    `totalCount=${String(pageOf<RoomItem>(roomsByCapacitySort, 'rooms').totalCount)}, capacities=${JSON.stringify(capacities)}`,
  )

  const equipmentByName = await show(`{ equipment(search: "${EQUIPMENT_PREFIX}Whiteboard") { totalCount items { name quantityAvailable } } }`)
  const equipmentNamePage = pageOf<EquipmentItem>(equipmentByName, 'equipment')
  check(
    'equipment search matches by name ("S4 Whiteboard")',
    equipmentNamePage.items.length === 1 && equipmentNamePage.items[0]?.name === `${EQUIPMENT_PREFIX}Whiteboard`,
    `totalCount=${String(equipmentNamePage.totalCount)}, items=${JSON.stringify(equipmentNamePage.items)}`,
  )

  const equipmentBySort = await show(
    `{ equipment(sort: { field: "quantityAvailable", direction: "DESC" }) { totalCount items { name quantityAvailable } } }`,
  )
  const quantities = pageOf<EquipmentItem>(equipmentBySort, 'equipment').items.map((item) => item.quantityAvailable)
  check(
    'equipment sort quantityAvailable DESC returns rows in descending quantity order',
    quantities.length > 0 && isDescending(quantities, (left, right) => left - right),
    `totalCount=${String(pageOf<EquipmentItem>(equipmentBySort, 'equipment').totalCount)}, quantities=${JSON.stringify(quantities)}`,
  )
}

async function cleanup(dataSource: DataSource): Promise<void> {
  await dataSource.getRepository(Employee).delete([{ email: Like(`${FIXTURE_PREFIX}%`) }, { email: Like(`${NFR_PREFIX}%`) }])
  await dataSource.query('DELETE FROM meeting_room WHERE name LIKE $1', [`${ROOM_PREFIX}%`])
  await dataSource.query('DELETE FROM equipment WHERE name LIKE $1', [`${EQUIPMENT_PREFIX}%`])
}

async function reportCleanup(dataSource: DataSource): Promise<void> {
  const employees = (await dataSource.query(
    'SELECT count(*)::int AS c FROM employee WHERE email LIKE $1 OR email LIKE $2',
    [`${FIXTURE_PREFIX}%`, `${NFR_PREFIX}%`],
  )) as Array<{ c: number }>
  const rooms = (await dataSource.query('SELECT count(*)::int AS c FROM meeting_room WHERE name LIKE $1', [
    `${ROOM_PREFIX}%`,
  ])) as Array<{ c: number }>
  const equipment = (await dataSource.query('SELECT count(*)::int AS c FROM equipment WHERE name LIKE $1', [
    `${EQUIPMENT_PREFIX}%`,
  ])) as Array<{ c: number }>
  const orphanRoles = (await dataSource.query(
    'SELECT count(*)::int AS c FROM user_role ur LEFT JOIN employee e ON e.id = ur.employee_id WHERE e.id IS NULL',
  )) as Array<{ c: number }>
  log('')
  log('CLEANUP — all S4 fixtures removed')
  log(`  leftover S4 employees=${String(employees[0]?.c)}, S4 rooms=${String(rooms[0]?.c)}, S4 equipment=${String(equipment[0]?.c)}`)
  log(`  orphaned user_role rows after employee deletes (FK cascade)=${String(orphanRoles[0]?.c)}`)
  check(
    'no S4 fixture rows remain and no orphaned role assignments were left behind',
    (employees[0]?.c ?? -1) === 0 && (rooms[0]?.c ?? -1) === 0 && (equipment[0]?.c ?? -1) === 0 && (orphanRoles[0]?.c ?? -1) === 0,
    `employees=${String(employees[0]?.c)}, rooms=${String(rooms[0]?.c)}, equipment=${String(equipment[0]?.c)}, orphan user_role=${String(orphanRoles[0]?.c)}`,
  )
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
  log(`S4 acceptance suite — server pid ${process.pid}, port ${port}, db ${env.db.name}`)
  log(`fixtures: employees "${FIXTURE_PREFIX}*" / "${NFR_PREFIX}*", rooms and equipment named "${ROOM_PREFIX}*"`)

  try {
    await login()
    const duplicateId = await test1DuplicateEmail()
    await test2DeleteGuards(dataSource, duplicateId)
    await test3Nfr1ConstantQueryCount(dataSource)
    await test4RoomLifecycle()
    await test5EquipmentLifecycle()
    await test6SearchAndSort()
  } finally {
    await cleanup(dataSource)
    await reportCleanup(dataSource)
    server.close()
    await dataSource.destroy()
  }

  log('')
  if (failures === 0) {
    log('RESULT: all S4 acceptance checks passed')
    process.exit(0)
  }
  log(`RESULT: ${String(failures)} check(s) FAILED`)
  process.exit(1)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`S4 acceptance suite crashed: ${message}`)
  process.exit(1)
})
