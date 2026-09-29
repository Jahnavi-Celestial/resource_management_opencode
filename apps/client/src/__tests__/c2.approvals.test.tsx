import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatDateTime } from '@/lib/format'
import {
  adminToken,
  bootServer,
  clearOutboxFor,
  envValue,
  gql,
  gqlRaw,
  lastRequest,
  newClient,
  recorded,
  renderApp,
  rowOnThisPage,
  showRow,
  signInAndWait,
  signOutIfSignedIn,
  stopServer,
  unexpectedRejections,
  waitForRequest,
} from './c2.harness'

/**
 * C2 acceptance suite, third half: the manager's approval queue and the two
 * decisions (FR-50–56), against a real server and the app that ships.
 *
 * The six claims are the requirements' own:
 *   1. the queue lists only PENDING requests, newest-first by default, with a
 *      working search and sortable columns wired to the server's own arguments
 *      (FR-50);
 *   2. approving transitions the booking to APPROVED and the screen shows the
 *      server's own answer (FR-51/52);
 *   3. a rejection reason the server considers too short is refused, and the
 *      server's message is rendered under the reason input (FR-54, NFR-6);
 *   4. a valid reason transitions the booking to REJECTED with that reason
 *      stored (FR-54);
 *   5. NFR-5, *both halves*: the controls a session may not use are not offered,
 *      and a direct call with that same session's token is refused anyway;
 *   6. a manager who tries to decide their own request gets the server's FR-56
 *      refusal, rendered in the dialog they are looking at, and the booking is
 *      untouched.
 *
 * Four things about *how* it is written, each a trap this shared development
 * database sets:
 *
 * - **The queue is global.** `pendingQueue` takes no `filter`, so a client cannot
 *   scope it, and it is ordered newest-first by default — which in a database that
 *   every client suite has added PENDING bookings to means this run's fixtures
 *   are never on page 1. So the UI half of test 1 goes to the *last* page (the
 *   newest rows) and the whole-queue half walks every page. No assertion anywhere
 *   compares a count to a literal: see the "no global count" rule in AGENTS.md,
 *   which three server suites had to be rescoped for.
 * - **Row controls are found within their own row.** Every page holds up to a
 *   hundred rows and each one has its own Approve/Reject buttons, so
 *   `getByTestId('row-approve')` would be ambiguous — the row is located by the
 *   booking's `data-id` and the button is scoped to it.
 * - **The decider is a real Manager, not the bootstrap admin.** A fixture
 *   employee holds the seeded Manager role (and the Employee role too, so it
 *   can be the requester of its own booking in test 6). The admin is used only to
 *   build fixtures and clean up, so none of the six claims rides on a superuser's
 *   permission set.
 * - **No server string is duplicated.** The too-short-reason message, the FR-56
 *   refusal and the FORBIDDEN message are each read off the wire by a direct call
 *   and compared with what the screen rendered, so the assertions cannot pass on
 *   a client that invented a matching string of its own.
 */

const PASSWORD = 'Fixture@12345'
const TOKEN = `c2a-${Date.now().toString(36)}-`
const ROOM_NAME = `${TOKEN}room`
const ROOM_LOCATION = 'Level 4, north wing'
const ROOM_CAPACITY = 10
const PROJECTOR_NAME = `${TOKEN}projector`
const LONG_REASON = `${TOKEN}the room is reserved for maintenance that evening`

const REQUESTER_FIRST = 'Rae'
const REQUESTER_LAST = 'Requester'
const MANAGER_FIRST = 'Manny'
const MANAGER_LAST = 'Manager'

const LOGIN = `mutation Login($input: LoginInput!) { login(input: $input) }`
const CREATE_EMPLOYEE = `mutation CreateEmployee($input: CreateEmployeeInput!) {
  createEmployee(input: $input) { id email }
}`
const DELETE_EMPLOYEE = `mutation DeleteEmployee($id: String!) { deleteEmployee(id: $id) }`
const ASSIGN_ROLE = `mutation AssignRole($input: EmployeeRoleInput!) {
  assignRoleToEmployee(input: $input) { id }
}`
const CREATE_ROLE = `mutation CreateRole($input: CreateRoleInput!) {
  createRole(input: $input) { id roleName }
}`
const DELETE_ROLE = `mutation DeleteRole($id: String!) { deleteRole(id: $id) }`
const ASSIGN_PERMISSION = `mutation AssignPermission($input: RolePermissionInput!) {
  assignPermissionToRole(input: $input) { id }
}`
const CREATE_ROOM = `mutation CreateRoom($input: CreateRoomInput!) {
  createRoom(input: $input) { id name }
}`
const RETIRE_ROOM = `mutation RetireRoom($input: UpdateRoomInput!) {
  updateRoom(input: $input) { id }
}`
const CREATE_EQUIPMENT = `mutation CreateEquipment($input: CreateEquipmentInput!) {
  createEquipment(input: $input) { id name }
}`
const RETIRE_EQUIPMENT = `mutation RetireEquipment($input: UpdateEquipmentInput!) {
  updateEquipment(input: $input) { id }
}`
const CREATE_BOOKING = `mutation CreateBooking($input: CreateBookingInput!) {
  createBooking(input: $input) { id status }
}`
const APPROVE = `mutation Approve($id: ID!) { approveBooking(id: $id) { id status } }`
const REJECT = `mutation Reject($input: RejectBookingInput!) {
  rejectBooking(input: $input) { id status }
}`
const READ_BOOKING = `query ReadBooking($id: ID!) {
  booking(id: $id) { id status rejectionReason processedAt processedBy { id } }
}`

/** Deliberately shorter than the server's `REJECTION_REASON_MIN_LENGTH`. */
const SHORT_REASON = 'nope'

interface BookingInput {
  roomId: string
  startTime: string
  endTime: string
  purpose: string
  numberOfAttendees: number
  equipment?: { equipmentId: string; quantity: number }[]
}

interface QueueItem {
  id: string
  status: string
  createdAt: string
  startTime: string
  endTime: string
}

/** A window `days` from now, so no fixture is ever in the past. */
function windowAt(days: number, hour: number): { start: Date; end: Date } {
  const start = new Date()
  start.setDate(start.getDate() + days)
  start.setHours(hour, 0, 0, 0)
  return { start, end: new Date(start.getTime() + 60 * 60_000) }
}

const W_APPROVE = windowAt(7, 9)
const W_SHORT_REASON = windowAt(7, 11)
const W_REJECT = windowAt(7, 13)
const W_SELF = windowAt(7, 15)
const W_APPROVED_FIXTURE = windowAt(8, 9)
const W_REJECTED_FIXTURE = windowAt(8, 11)

let roomId = ''
let projectorId = ''
const createdEmployeeIds: string[] = []
let customRoleId = ''

/** The decider: seeded Manager + Employee, so it can also be a requester. */
let managerEmail = ''
let managerToken = ''
/** A plain employee: `booking:create` and nothing near a decision. */
let requesterEmail = ''
let requesterToken = ''
/** Holds only `booking:approve` — can reach the queue, must never be offered Reject. */
let approverOnlyEmail = ''
let approverOnlyToken = ''

/** PENDING, in the order the tests consume them. */
let pendingApproveId = ''
let pendingShortReasonId = ''
let pendingRejectId = ''
let pendingSelfId = ''

/** Decided in `beforeAll`, so "only PENDING" has something to be false about. */
let approvedFixtureId = ''
let rejectedFixtureId = ''

async function login(email: string): Promise<string> {
  const result = await gql<{ login: string }>(
    LOGIN,
    { input: { email, password: PASSWORD } },
  )
  return result.login
}

async function createEmployee(first: string, last: string, email: string): Promise<string> {
  const created = await gql<{ createEmployee: { id: string } }>(
    CREATE_EMPLOYEE,
    { input: { firstName: first, lastName: last, email, password: PASSWORD } },
    adminToken,
  )
  createdEmployeeIds.push(created.createEmployee.id)
  return created.createEmployee.id
}

async function roleIdByName(roleName: string): Promise<string> {
  const roles = await gql<{ roles: { items: { id: string; roleName: string }[] } }>(
    `query { roles(pageSize: 100) { items { id roleName } } }`,
    {},
    adminToken,
  )
  const role = roles.roles.items.find((item) => item.roleName === roleName)
  if (role === undefined) {
    throw new Error(`seeded ${roleName} role is missing`)
  }
  return role.id
}

async function createBooking(token: string, input: BookingInput): Promise<string> {
  const created = await gql<{ createBooking: { id: string; status: string } }>(
    CREATE_BOOKING,
    { input },
    token,
  )
  expect(created.createBooking.status).toBe('PENDING')
  return created.createBooking.id
}

async function readBooking(
  id: string,
  token: string,
): Promise<{ status: string; rejectionReason: string | null; processedAt: string | null }> {
  const read = await gql<{
    booking: { status: string; rejectionReason: string | null; processedAt: string | null }
  }>(READ_BOOKING, { id }, token)
  return read.booking
}

/**
 * Every pending row the server has, page by page, in the order it sent them.
 *
 * A walk rather than a count, twice over: the queue cannot be searched, so the
 * only way to see all of it is to page through it, and this suite shares a
 * database whose pending set grows with every client run.
 */
async function walkQueue(token: string): Promise<QueueItem[]> {
  const collected: QueueItem[] = []
  let page = 1
  for (;;) {
    const response = await gql<{ pendingQueue: { totalCount: number; items: QueueItem[] } }>(
      `query Walk($page: Int!, $pageSize: Int!) {
        pendingQueue(page: $page, pageSize: $pageSize) { totalCount items { id status createdAt startTime endTime } }
      }`,
      { page, pageSize: 100 },
      token,
    )
    collected.push(...response.pendingQueue.items)
    if (collected.length >= response.pendingQueue.totalCount) {
      return collected
    }
    page += 1
    expect(page, 'the queue did not end — walkQueue is looping').toBeLessThan(50)
  }
}

beforeAll(async () => {
  await bootServer()
  const employeeRoleId = await roleIdByName('Employee')
  const managerRoleId = await roleIdByName('Manager')

  roomId = (
    await gql<{ createRoom: { id: string } }>(
      CREATE_ROOM,
      { input: { name: ROOM_NAME, location: ROOM_LOCATION, capacity: ROOM_CAPACITY } },
      adminToken,
    )
  ).createRoom.id
  projectorId = (
    await gql<{ createEquipment: { id: string } }>(
      CREATE_EQUIPMENT,
      { input: { name: PROJECTOR_NAME, quantityAvailable: 3 } },
      adminToken,
    )
  ).createEquipment.id

  // The plain employee: creates the requests.
  requesterEmail = `${TOKEN}requester@resource.local`
  const requesterId = await createEmployee(REQUESTER_FIRST, REQUESTER_LAST, requesterEmail)
  await gql(ASSIGN_ROLE, { input: { employeeId: requesterId, roleId: employeeRoleId } }, adminToken)
  requesterToken = await login(requesterEmail)

  // The decider. The Employee role as well as Manager's, because FR-56 needs a
  // requester who also holds `booking:approve` — which is a real configuration
  // (a manager who books rooms), not a fixture contrivance.
  managerEmail = `${TOKEN}manager@resource.local`
  const managerId = await createEmployee(MANAGER_FIRST, MANAGER_LAST, managerEmail)
  await gql(ASSIGN_ROLE, { input: { employeeId: managerId, roleId: employeeRoleId } }, adminToken)
  await gql(ASSIGN_ROLE, { input: { employeeId: managerId, roleId: managerRoleId } }, adminToken)
  managerToken = await login(managerEmail)

  // An approver-only role, built through the API: `booking:approve` plus
  // `booking:read:all`, and deliberately *not* `booking:reject`. This is the
  // session that makes test 5's client half meaningful — the queue's own guard is
  // `booking:approve`, so this user reaches the screen and the screen still owes
  // them no Reject button.
  //
  // The read permission is not decoration: the queue document asks for each
  // requester's name, and `BookingResolver.requester` calls `readScope` for that
  // request's "other recent bookings" even when the client selects only the name.
  // A session with `booking:approve` and no read scope is refused on *that field*,
  // which fails the whole query — so an approver who cannot read bookings cannot
  // see the queue at all. Worth knowing, and the reason this role is not a single
  // permission.
  const managerRole = await gql<{
    role: { permissions: { id: string; permissionName: string }[] }
  }>(`query ReadRole($id: String!) { role(id: $id) { permissions { id permissionName } } }`, { id: managerRoleId }, adminToken)
  const permissionId = (permissionName: string): string => {
    const permission = managerRole.role.permissions.find(
      (candidate) => candidate.permissionName === permissionName,
    )
    if (permission === undefined) {
      throw new Error(`${permissionName} is missing from the seeded Manager role`)
    }
    return permission.id
  }
  customRoleId = (
    await gql<{ createRole: { id: string } }>(
      CREATE_ROLE,
      { input: { roleName: `${TOKEN}approver` } },
      adminToken,
    )
  ).createRole.id
  for (const key of ['booking:approve', 'booking:read:all']) {
    await gql(
      ASSIGN_PERMISSION,
      { input: { roleId: customRoleId, permissionId: permissionId(key) } },
      adminToken,
    )
  }
  approverOnlyEmail = `${TOKEN}approver@resource.local`
  const approverId = await createEmployee('Ada', 'Approver', approverOnlyEmail)
  await gql(ASSIGN_ROLE, { input: { employeeId: approverId, roleId: customRoleId } }, adminToken)
  approverOnlyToken = await login(approverOnlyEmail)

  // One room, six non-overlapping hours: the exclusion constraint
  // (`ex_booking_room_time_range`) forbids two committed bookings in one room at
  // once, and every fixture below is PENDING or APPROVED at some point.
  pendingApproveId = await createBooking(requesterToken, {
    roomId,
    startTime: W_APPROVE.start.toISOString(),
    endTime: W_APPROVE.end.toISOString(),
    purpose: `${TOKEN}approve-me`,
    numberOfAttendees: 4,
    equipment: [{ equipmentId: projectorId, quantity: 1 }],
  })
  pendingShortReasonId = await createBooking(requesterToken, {
    roomId,
    startTime: W_SHORT_REASON.start.toISOString(),
    endTime: W_SHORT_REASON.end.toISOString(),
    purpose: `${TOKEN}short-reason`,
    numberOfAttendees: 2,
  })
  pendingRejectId = await createBooking(requesterToken, {
    roomId,
    startTime: W_REJECT.start.toISOString(),
    endTime: W_REJECT.end.toISOString(),
    purpose: `${TOKEN}reject-me`,
    numberOfAttendees: 6,
  })
  // FR-56's subject: requested *by* the decider.
  pendingSelfId = await createBooking(managerToken, {
    roomId,
    startTime: W_SELF.start.toISOString(),
    endTime: W_SELF.end.toISOString(),
    purpose: `${TOKEN}self-decision`,
    numberOfAttendees: 3,
  })

  // Two already-decided requests, so "the queue shows only PENDING" is a claim
  // about bookings that exist rather than about an empty set.
  approvedFixtureId = await createBooking(requesterToken, {
    roomId,
    startTime: W_APPROVED_FIXTURE.start.toISOString(),
    endTime: W_APPROVED_FIXTURE.end.toISOString(),
    purpose: `${TOKEN}already-approved`,
    numberOfAttendees: 5,
  })
  await gql(APPROVE, { id: approvedFixtureId }, managerToken)
  rejectedFixtureId = await createBooking(requesterToken, {
    roomId,
    startTime: W_REJECTED_FIXTURE.start.toISOString(),
    endTime: W_REJECTED_FIXTURE.end.toISOString(),
    purpose: `${TOKEN}already-rejected`,
    numberOfAttendees: 5,
  })
  await gql(REJECT, { input: { id: rejectedFixtureId, reason: LONG_REASON } }, managerToken)
}, 180_000)

afterAll(() => {
  const escaped = unexpectedRejections()
  expect(
    escaped.map((reason) =>
      reason instanceof Error
        ? `${reason.name}: ${reason.message}\n${(reason.stack ?? '').split('\n').slice(0, 6).join('\n')}`
        : String(reason),
    ),
  ).toEqual([])
})

afterAll(async () => {
  // Decision mail first, employees second: the outbox is addressed, so the
  // address is the only handle on these rows and the employees are about to stop
  // existing. Approving and rejecting is most of what this suite does, so
  // skipping this leaves a dev server's cron something real to send.
  // Asserted non-vacuously: this suite decides four bookings (one approval, one
  // rejection, plus the two decided in `beforeAll`), so a cleanup that quietly
  // matched nothing would leave four rows behind for a dev server's cron to send —
  // and `expect(0).toBeGreaterThanOrEqual(0)` would have called that a pass.
  const cleared = await clearOutboxFor([requesterEmail, managerEmail, approverOnlyEmail])
  expect(cleared).toBeGreaterThanOrEqual(4)

  for (const id of createdEmployeeIds) {
    await gql(DELETE_EMPLOYEE, { id }, adminToken).catch(() => undefined)
  }
  if (customRoleId !== '') {
    await gql(DELETE_ROLE, { id: customRoleId }, adminToken).catch(() => undefined)
  }
  if (roomId !== '') {
    await gql(RETIRE_ROOM, { input: { id: roomId, isActive: false } }, adminToken).catch(
      () => undefined,
    )
  }
  if (projectorId !== '') {
    await gql(
      RETIRE_EQUIPMENT,
      { input: { id: projectorId, isActive: false } },
      adminToken,
    ).catch(() => undefined)
  }
  await stopServer()
}, 120_000)

/**
 * Signs one person in and opens the queue route, and returns once the app has
 * settled on *either* landing: the grid, or the guard's refusal.
 *
 * Both are real outcomes of this route, and which one you get is decided by the
 * session rather than by the route — so a helper that waited for the grid would
 * turn test 5's own claim (a session with no `booking:approve` is refused the
 * route) into a 5-second timeout.
 */
async function openQueueAs(
  email: string,
  password: string,
): Promise<ReturnType<typeof renderApp>> {
  const view = renderApp(newClient(), '/bookings/approvals')
  await signOutIfSignedIn()
  await signInAndWait(email, password)
  await waitFor(() => {
    expect(
      screen.queryByTestId('datatable') ?? screen.queryByTestId('guard-denied'),
      `the queue route never settled for ${email}`,
    ).toBeInTheDocument()
  })
  return view
}

describe('C2 — approval queue and decisions (FR-50–56)', () => {
  it('1. shows only PENDING requests, newest-first, with search and sortable columns', async () => {
    const view = await openQueueAs(managerEmail, PASSWORD)
    const firstRequest = await waitForRequest('PendingQueue', (variables) => variables['page'] === 1)

    // The screen sends the arguments the endpoint has: page, pageSize, and the
    // default sort (newest-first) from its initial table state. No filter — the
    // queue takes none.
    expect(Object.keys(firstRequest.variables).sort()).toEqual(['page', 'pageSize', 'sort'])
    expect(firstRequest.variables['sort']).toEqual({ field: 'createdAt', direction: 'DESC' })
    // …and a search box, because the queue can be searched.
    expect(screen.getByTestId('table-search')).toBeInTheDocument()

    // Sorting is the server's, not the page's: clicking a header puts a `sort`
    // into the variables, and the rows that come back are the server's order.
    const before = recorded.length
    await userEvent.setup().click(screen.getByRole('columnheader', { name: /requested from/i }))
    const sortRequest = await waitForRequest(
      'PendingQueue',
      (variables) => (variables['sort'] as { field?: string } | undefined)?.['field'] === 'startTime',
    )
    expect(sortRequest.variables['sort']).toEqual({ field: 'startTime', direction: 'ASC' })
    expect(recorded.slice(before).length).toBeGreaterThanOrEqual(1)

    // Search reaches the server as a variable after the table's debounce, and
    // the rows that come back are the server's filtered answer.
    const searchBox = screen.getByTestId('table-search')
    await userEvent.setup().type(searchBox, `${TOKEN}approve-me`)
    const searchRequest = await waitForRequest(
      'PendingQueue',
      (variables) => variables['search'] === `${TOKEN}approve-me`,
    )
    expect(searchRequest.variables['search']).toBe(`${TOKEN}approve-me`)
    await waitFor(() => {
      for (const row of screen.getAllByRole('row').slice(1)) {
        expect(row).toHaveTextContent(`${TOKEN}approve-me`)
      }
    })
    // Clearing the search puts the whole queue back. No request is waited for
    // here: the cleared variables are exactly the sort-click request's, which the
    // server has already answered, so Apollo serves them from the cache and
    // nothing reaches the wire. The observable is the rendered total.
    await userEvent.setup().clear(searchBox)
    await waitFor(() => {
      expect(screen.getByTestId('table-total')).not.toHaveTextContent('1 total')
    })

    // Restore the default order (newest-first). The header click above left the
    // grid sorted by start time, which scatters this run's fixtures across pages
    // — and the two `showRow` calls below would then land on different pages, the
    // second navigating away and detaching the row the first one returned.
    // The second click's variables are the initial request's, already answered,
    // so no request is waited for — the header's own sort indicator is the
    // observable.
    const createdHeader = screen.getByRole('columnheader', { name: /^created/i })
    await userEvent.setup().click(createdHeader)
    await new Promise((resolve) => setTimeout(resolve, 700))
    await userEvent.setup().click(createdHeader)
    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /^created/i })).toHaveAttribute('aria-sort', 'descending')
    })

    // The server's own queue, walked in full: this run's PENDING requests are in
    // it, the two already-decided ones are not, and it is newest-first.
    const queue = await walkQueue(managerToken)
    const ids = queue.map((item) => item.id)
    for (const pending of [pendingApproveId, pendingShortReasonId, pendingRejectId, pendingSelfId]) {
      expect(ids, 'a PENDING fixture is missing from the queue').toContain(pending)
    }
    expect(ids).not.toContain(approvedFixtureId)
    expect(ids).not.toContain(rejectedFixtureId)
    expect(queue.every((item) => item.status === 'PENDING')).toBe(true)
    const createdAts = queue.map((item) => new Date(item.createdAt).getTime())
    for (let index = 1; index < createdAts.length; index += 1) {
      expect(
        createdAts[index] ?? 0,
        'the queue is not newest-first',
      ).toBeLessThanOrEqual(createdAts[index - 1] ?? 0)
    }

    // The screen's own rows: two of this run's requests, each PENDING, with the
    // window FR-50 asks the queue to show.
    const approveRow = await showRow(pendingApproveId)
    const rejectRow = await showRow(pendingShortReasonId)
    for (const row of [approveRow, rejectRow]) {
      expect(row).toHaveTextContent('PENDING')
    }
    expect(approveRow).toHaveTextContent(formatDateTime(W_APPROVE.start.toISOString()))
    expect(approveRow).toHaveTextContent(formatDateTime(W_APPROVE.end.toISOString()))
    expect(approveRow).toHaveTextContent(`${REQUESTER_FIRST} ${REQUESTER_LAST}`)
    expect(approveRow).toHaveTextContent(`${TOKEN}approve-me`)
    // The equipment line is on the row, so the queue shows what is being asked for.
    expect(approveRow).toHaveTextContent(`${PROJECTOR_NAME}`)
    // Every rendered row is PENDING: not one decided request has leaked in.
    for (const row of screen.getAllByRole('row').slice(1)) {
      expect(row).toHaveTextContent('PENDING')
    }
    expect(within(approveRow).getByTestId('row-approve')).toBeInTheDocument()
    expect(within(approveRow).getByTestId('row-reject')).toBeInTheDocument()

    // A row click is a shortcut to the detail view, and the action buttons do not
    // also trigger it: the click that opens the confirm dialog must not navigate.
    await userEvent.setup().click(within(approveRow).getByTestId('row-approve'))
    await screen.findByTestId('confirm-dialog')
    expect(screen.queryByTestId('booking-detail')).not.toBeInTheDocument()
    view.unmount()
  }, 120_000)

  it('2. approving transitions the booking to APPROVED, and the screen shows the server\'s answer', async () => {
    const view = await openQueueAs(managerEmail, PASSWORD)
    const row = await showRow(pendingApproveId)
    await userEvent.setup().click(within(row).getByTestId('row-approve'))
    await screen.findByTestId('confirm-dialog')
    // The confirmation names what is about to be approved, so the decision is not
    // made against an unidentified row.
    expect(screen.getByTestId('confirm-message')).toHaveTextContent(
      formatDateTime(W_APPROVE.start.toISOString()),
    )
    await userEvent.setup().click(screen.getByTestId('confirm-accept'))

    // The server's own status, not a string this screen invented.
    const notice = await screen.findByTestId('approval-notice')
    expect(within(notice).getByTestId('approval-notice-status')).toHaveTextContent('APPROVED')
    expect(within(notice).getByTestId('approval-notice-id')).toHaveTextContent(pendingApproveId)

    // And the mutation's own answer, read back over the API: the booking is
    // APPROVED, carries the server's processed time (FR-46's audit-derived value)
    // and names the decider.
    const stored = await readBooking(pendingApproveId, managerToken)
    expect(stored.status).toBe('APPROVED')
    expect(stored.processedAt).not.toBeNull()

    // The queue refetches, and a decided request leaves it — which is also the
    // screen's way of saying the row is no longer waiting. Matched on the row's
    // own `data-id`, not on its text: the id is not in the row's accessible name,
    // so a name regex here would pass whether the row was there or not.
    await waitFor(() => {
      expect(rowOnThisPage(pendingApproveId)).toBeNull()
    })
    expect(await walkQueue(managerToken).then((items) => items.map((item) => item.id))).not.toContain(
      pendingApproveId,
    )
    view.unmount()
  }, 120_000)

  it('3. a reason the server calls too short is refused, with the server\'s own message under the input', async () => {
    // The message is read off the wire, not written here: the client must not
    // carry a copy of the server's minimum or its wording (the reason length is
    // `REJECTION_REASON_MIN_LENGTH`, and a client constant would drift the moment
    // the environment changed it). Note *where* the server puts it — the top-level
    // message of a field error is the generic "Validation failed" and the specific
    // text is in `extensions.fieldErrors`, so the expectation is the field's.
    const probe = await gqlRaw<{ rejectBooking: unknown }>(
      REJECT,
      { input: { id: pendingShortReasonId, reason: SHORT_REASON } },
      managerToken,
    )
    const fieldErrors = probe.errors?.[0]?.extensions?.['fieldErrors'] as
      | { field: string; message: string }[]
      | undefined
    const reasonError = fieldErrors?.find((entry) => entry.field === 'reason')
    expect(reasonError?.message ?? '').not.toBe('')

    const view = await openQueueAs(managerEmail, PASSWORD)
    const row = await showRow(pendingShortReasonId)
    await userEvent.setup().click(within(row).getByTestId('row-reject'))

    const dialog = await screen.findByTestId('form-dialog')
    // A short reason really goes to the server: the field is `required` and
    // nothing more, because a client `minLength` would block the request and the
    // user would never read the refusal the server actually sent.
    await userEvent.setup().type(within(dialog).getByLabelText(/reason/i), SHORT_REASON)
    const mark = recorded.length
    await userEvent.setup().click(within(dialog).getByTestId('form-submit'))
    await waitForRequest(
      'RejectBooking',
      (variables) => (variables['input'] as { reason?: string } | undefined)?.reason === SHORT_REASON,
      mark,
    )

    // NFR-6: under the input the user has to change, not in a banner above it.
    const inline = await screen.findByTestId('field-error-reason')
    expect(inline).toHaveTextContent(reasonError?.message as string)
    expect(screen.queryByTestId('form-error')).not.toBeInTheDocument()

    // The dialog is still open with the typed reason, and nothing was decided.
    expect(screen.getByTestId('form-dialog')).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/reason/i)).toHaveValue(SHORT_REASON)
    expect((await readBooking(pendingShortReasonId, managerToken)).status).toBe('PENDING')
    view.unmount()
  }, 120_000)

  it('4. a valid reason rejects the booking and stores that reason', async () => {
    const view = await openQueueAs(managerEmail, PASSWORD)
    const row = await showRow(pendingRejectId)
    await userEvent.setup().click(within(row).getByTestId('row-reject'))
    const dialog = await screen.findByTestId('form-dialog')
    await userEvent.setup().type(within(dialog).getByLabelText(/reason/i), LONG_REASON)
    await userEvent.setup().click(within(dialog).getByTestId('form-submit'))

    const notice = await screen.findByTestId('approval-notice')
    expect(within(notice).getByTestId('approval-notice-status')).toHaveTextContent('REJECTED')

    const stored = await readBooking(pendingRejectId, managerToken)
    expect(stored.status).toBe('REJECTED')
    expect(stored.rejectionReason).toBe(LONG_REASON)

    // Same `data-id` match as the approval half: this row is gone because the
    // decision succeeded, not because the assertion cannot find it.
    await waitFor(() => {
      expect(rowOnThisPage(pendingRejectId)).toBeNull()
    })
    view.unmount()
  }, 120_000)

  it('5. NFR-5: the controls a session may not use are not offered, and a direct call is refused anyway', async () => {
    // Half one, a session that holds `booking:approve` but not `booking:reject`:
    // it reaches the queue (its guard is `booking:approve`) and is offered no
    // Reject button anywhere on the page.
    const approverView = await openQueueAs(approverOnlyEmail, PASSWORD)
    const row = await showRow(pendingSelfId)
    expect(within(row).getByTestId('row-approve')).toBeInTheDocument()
    // Not just on this row: nowhere on the page.
    expect(screen.queryAllByTestId('row-reject')).toEqual([])
    approverView.unmount()

    // Half two, the same session's token, sent straight to the server: the
    // missing `booking:reject` is the server's rule, not the button's.
    const refusedReject = await gqlRaw<{ rejectBooking: unknown }>(
      REJECT,
      { input: { id: pendingSelfId, reason: LONG_REASON } },
      approverOnlyToken,
    )
    expect(refusedReject.errors?.[0]?.extensions?.['code']).toBe('FORBIDDEN')
    expect(refusedReject.errors?.[0]?.message).toBe('Not authorised')
    expect((await readBooking(pendingSelfId, approverOnlyToken)).status).toBe('PENDING')

    // And the other direction, from a session with neither decision permission:
    // the nav item is not drawn, the route itself is refused…
    const employeeView = await openQueueAs(requesterEmail, PASSWORD)
    expect(screen.queryByRole('link', { name: /approvals/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('datatable')).not.toBeInTheDocument()
    expect(screen.queryByTestId('row-approve')).not.toBeInTheDocument()
    expect(screen.queryByTestId('row-reject')).not.toBeInTheDocument()
    expect(screen.queryByTestId('guard-denied')).toBeInTheDocument()
    employeeView.unmount()

    // …and the direct mutation is refused too. Read the booking back with the
    // *manager's* token: the requester holds `booking:read:own` and this booking
    // is not theirs, so asking them would be refused on the read, which would say
    // nothing about whether the refused approval changed anything.
    const refusedApprove = await gqlRaw<{ approveBooking: unknown }>(
      APPROVE,
      { id: pendingSelfId },
      requesterToken,
    )
    expect(refusedApprove.errors?.[0]?.extensions?.['code']).toBe('FORBIDDEN')
    expect(refusedApprove.errors?.[0]?.message).toBe('Not authorised')
    const unchanged = await readBooking(pendingSelfId, managerToken)
    expect(unchanged.status).toBe('PENDING')
    expect(unchanged.processedAt).toBeNull()
  }, 120_000)

  it('6. a manager deciding their own request gets the server\'s refusal, in the dialog, with nothing changed', async () => {
    const view = await openQueueAs(managerEmail, PASSWORD)
    const row = await showRow(pendingSelfId)
    // The control is *offered*: the self-decision rule is FR-56 and the server
    // owns it (NFR-5), so hiding it here would only remove the proof that the
    // refusal is ever rendered.
    expect(within(row).getByTestId('row-approve')).toBeInTheDocument()
    await userEvent.setup().click(within(row).getByTestId('row-approve'))
    await screen.findByTestId('confirm-dialog')
    await userEvent.setup().click(screen.getByTestId('confirm-accept'))

    // The refusal, read off the wire for the same booking and the same session…
    const refused = await gqlRaw<{ approveBooking: unknown }>(APPROVE, { id: pendingSelfId }, managerToken)
    const serverMessage = refused.errors?.[0]?.message
    expect(serverMessage).toBeTruthy()

    // …and rendered in the dialog the user is looking at. A banner on the page
    // behind an open modal would be in the DOM and unreachable: MUI marks the
    // background `aria-hidden` while a modal is open.
    const alert = await screen.findByTestId('confirm-error')
    expect(alert).toHaveTextContent(serverMessage as string)
    expect(alert).toHaveTextContent(/cannot approve or reject/i)
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument()

    // No notice, no decision, and the request is still waiting.
    expect(screen.queryByTestId('approval-notice')).not.toBeInTheDocument()
    const stored = await readBooking(pendingSelfId, managerToken)
    expect(stored.status).toBe('PENDING')
    expect(stored.processedAt).toBeNull()
    view.unmount()
  }, 120_000)
})
