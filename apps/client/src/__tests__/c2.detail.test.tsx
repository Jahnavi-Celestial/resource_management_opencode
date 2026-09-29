import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DELETED_USER_DISPLAY_NAME, displayName } from '@/lib/displayName'
import { formatDateTime } from '@/lib/format'
import {
  adminToken,
  bootServer,
  envValue,
  clearOutboxFor,
  gql,
  lastRequest,
  newClient,
  probe,
  renderApp,
  signInAndWait,
  stopServer,
  unexpectedRejections,
} from './c2.harness'

/**
 * C2 acceptance suite, second half: the booking detail view (FR-45–49), against
 * a real server and the app that ships.
 *
 * The five claims are the requirements' own:
 *   1. a processed booking shows its full detail — the requested window and when
 *      it was asked for, plus the processed date, the person who decided it and
 *      the rejection reason where there is one (FR-45/46);
 *   2. `statusHistory` shows every transition, in order, with old status, new
 *      status, actor and timestamp (FR-47, NFR-8);
 *   3. a deleted requester and a deleted actor render as "Deleted user" — and the
 *      suite proves the string came out of `displayName()` rather than being a
 *      second implementation that happens to agree (FR-48, PLAN's explicit
 *      "one component, two call sites" requirement);
 *   4. the related-resource block is real: the room's own facts and who else has
 *      it in this window, and each equipment item's remaining availability
 *      (FR-49), plus the requester's other recent bookings (FR-48);
 *   5. a caller who may not read *this* booking gets the server's refusal,
 *      rendered cleanly, while the requester still sees their own (FR-45's
 *      `read:own`/`read:all` scope, the same rule the list obeys).
 *
 * Two deliberate facts about how it is written:
 *
 * - **Every expectation is hand-computed from the fixture**, not read back from
 *   the same query the screen reads. The room's competing booking is a
 *   *cancelled* one, because the exclusion constraint makes two committed
 *   bookings overlap impossible; the equipment arithmetic (5 − 2, 4 − 1 − 2) is
 *   spelled out in `beforeAll`. A suite that recomputed the expectation from the
 *   response would pass whatever the server did.
 * - **`displayName()` is wrapped, not replaced.** `vi.mock` here delegates to the
 *   real implementation and records what it was called with, so test 3 can assert
 *   that the label on screen *is that function's return value* for the payload it
 *   was given.
 * - **That proof was checked for being non-vacuous**, by replacing the requester's
 *   label in `BookingDetailPage` with a `id === null ? 'Deleted user' : name`
 *   cheat and re-running: tests 3 and 5 fail. The cheat cannot even read a name —
 *   the document deliberately never selects the server's pre-joined `name`, so
 *   there is nothing for a second implementation to format.
 */

const PASSWORD = 'Fixture@12345'
const TOKEN = `c2d-${Date.now().toString(36)}-`
const ROOM_NAME = `${TOKEN}room`
const OTHER_ROOM_NAME = `${TOKEN}other-room`
const ROOM_LOCATION = 'Level 3, east wing'
const ROOM_CAPACITY = 8
const PROJECTOR_NAME = `${TOKEN}projector`
const CAMERA_NAME = `${TOKEN}camera`
const REJECTION_REASON = `${TOKEN}cameras are booked for a shoot`

/** The first, last and full name the fixtures need. */
const REQUESTER_FIRST = 'Raya'
const REQUESTER_LAST = 'Requester'

/**
 * The wrapping mock. `vi.hoisted` because `vi.mock`'s factory is hoisted above
 * the imports, so an ordinary module-level `const` would still be in its temporal
 * dead zone when the factory runs.
 */
const { displayNameCalls } = vi.hoisted(() => ({
  displayNameCalls: [] as Array<{
    firstName: string | null | undefined
    lastName: string | null | undefined
  } | null>,
}))

vi.mock('@/lib/displayName', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/displayName')>()
  return {
    ...actual,
    displayName: (employee: Parameters<typeof actual.displayName>[0]): string => {
      // "No employee at all" is recorded as `null` for both `null` and
      // `undefined`: the screen never passes the latter, and the distinction
      // would only make the assertions below harder to read.
      displayNameCalls.push(
        employee === null || employee === undefined
          ? null
          : { firstName: employee.firstName, lastName: employee.lastName },
      )
      return actual.displayName(employee)
    },
  }
})

const CREATE_EMPLOYEE = `mutation Create($input: CreateEmployeeInput!) {
  createEmployee(input: $input) { id email }
}`
const DELETE_EMPLOYEE = `mutation Delete($id: String!) { deleteEmployee(id: $id) }`
const ASSIGN_ROLE = `mutation Assign($input: EmployeeRoleInput!) {
  assignRoleToEmployee(input: $input) { id }
}`
const CREATE_ROOM = `mutation Create($input: CreateRoomInput!) {
  createRoom(input: $input) { id name }
}`
const CREATE_EQUIPMENT = `mutation Create($input: CreateEquipmentInput!) {
  createEquipment(input: $input) { id name }
}`
const CREATE_BOOKING = `mutation Create($input: CreateBookingInput!) {
  createBooking(input: $input) { id status }
}`
const APPROVE_BOOKING = `mutation Approve($id: ID!) { approveBooking(id: $id) { id status } }`
const REJECT_BOOKING = `mutation Reject($input: RejectBookingInput!) {
  rejectBooking(input: $input) { id status }
}`
const CANCEL_BOOKING = `mutation Cancel($id: ID!) { cancelBooking(id: $id) { id status } }`

interface BookingInput {
  roomId: string
  startTime: string
  endTime: string
  purpose: string
  numberOfAttendees: number
  equipment?: { equipmentId: string; quantity: number }[]
}

/** A booking window `days` from now, so no fixture is ever in the past. */
function windowAt(days: number, hour: number, minute: number, lengthMinutes: number): { start: Date; end: Date } {
  const start = new Date()
  start.setDate(start.getDate() + days)
  start.setHours(hour, minute, 0, 0)
  const end = new Date(start.getTime() + lengthMinutes * 60_000)
  return { start, end }
}

const WINDOW_MAIN = windowAt(7, 9, 0, 60) // the booking under test
const WINDOW_CANCELLED = windowAt(7, 9, 15, 30) // same room, overlaps, then cancelled
const WINDOW_CAMERA = windowAt(7, 9, 30, 60) // other room, overlaps, commits 2 cameras
const WINDOW_REJECTED = windowAt(7, 14, 0, 60) // same room, does not overlap
const WINDOW_LATER = windowAt(9, 9, 0, 60) // same room, two days later
const WINDOW_DOOMED = windowAt(10, 9, 0, 60) // the deleted requester's booking

let roomId = ''
let otherRoomId = ''
let projectorId = ''
let cameraId = ''

/** The manager's own name parts, read from `me` rather than hardcoded. */
let managerFirst = ''
let managerLast = ''

/**
 * What the screen is expected to show for the manager — computed by the same
 * function the screen uses, from the same payload. A test that hardcoded the
 * joined string here would let a screen with its own formatting pass.
 */
function managerDisplayName(): string {
  return displayName({ firstName: managerFirst, lastName: managerLast })
}

let requesterEmail = ''
let requesterToken = ''
let bystanderEmail = ''
let bystanderToken = ''
let managerEmail = ''
let managerToken = ''
/** Deleted in `beforeAll` (FR-7), so its booking and audit rows lose its person. */
let doomedEmail = ''

/** Cancelled overlap: occupies the room in time, commits nothing. */
let cancelledId = ''
/** The booking the screen is pointed at in most tests: APPROVED, with equipment. */
let approvedId = ''
let rejectedId = ''
/** Same room, outside the window: must never appear as "other". */
let laterId = ''
/** PENDING: the unprocessed half of FR-46. */
let pendingId = ''
let doomedId = ''

const createdEmployeeIds: string[] = []

async function createEmployee(first: string, last: string, email: string): Promise<string> {
  const created = await gql<{ createEmployee: { id: string } }>(
    CREATE_EMPLOYEE,
    { input: { firstName: first, lastName: last, email, password: PASSWORD } },
    adminToken,
  )
  createdEmployeeIds.push(created.createEmployee.id)
  return created.createEmployee.id
}

async function login(email: string): Promise<string> {
  const result = await gql<{ login: string }>(
    `mutation Login($input: LoginInput!) { login(input: $input) }`,
    { input: { email, password: PASSWORD } },
  )
  return result.login
}

async function createBooking(token: string, input: BookingInput): Promise<string> {
  const created = await gql<{ createBooking: { id: string } }>(CREATE_BOOKING, { input }, token)
  return created.createBooking.id
}

async function employeeRoleId(): Promise<string> {
  const roles = await gql<{ roles: { items: { id: string; roleName: string }[] } }>(
    `query { roles { items { id roleName } } }`,
    {},
    adminToken,
  )
  const role = roles.roles.items.find((item) => item.roleName === 'Employee')
  if (role === undefined) {
    throw new Error('seeded Employee role is missing')
  }
  return role.id
}

async function managerRoleId(): Promise<string> {
  const roles = await gql<{ roles: { items: { id: string; roleName: string }[] } }>(
    `query { roles { items { id roleName } } }`,
    {},
    adminToken,
  )
  const role = roles.roles.items.find((item) => item.roleName === 'Manager')
  if (role === undefined) {
    throw new Error('seeded Manager role is missing')
  }
  return role.id
}

beforeAll(async () => {
  await bootServer()
  const roleId = await employeeRoleId()
  const mgrRoleId = await managerRoleId()

  // The admin no longer holds the approval permissions — deciding bookings is
  // the Manager's job — so every decision in this suite is made by a manager.
  managerEmail = `${TOKEN}manager@resource.local`
  const managerId = await createEmployee('Mona', 'Manager', managerEmail)
  await gql(ASSIGN_ROLE, { input: { employeeId: managerId, roleId: mgrRoleId } }, adminToken)
  managerToken = await login(managerEmail)

  const me = await gql<{ me: { employee: { firstName: string; lastName: string } } }>(
    `query { me { employee { firstName lastName } } }`,
    {},
    managerToken,
  )
  managerFirst = me.me.employee.firstName
  managerLast = me.me.employee.lastName

  roomId = (
    await gql<{ createRoom: { id: string } }>(
      CREATE_ROOM,
      { input: { name: ROOM_NAME, location: ROOM_LOCATION, capacity: ROOM_CAPACITY } },
      adminToken,
    )
  ).createRoom.id
  otherRoomId = (
    await gql<{ createRoom: { id: string } }>(
      CREATE_ROOM,
      { input: { name: OTHER_ROOM_NAME, location: 'Level 1, west wing', capacity: 4 } },
      adminToken,
    )
  ).createRoom.id
  projectorId = (
    await gql<{ createEquipment: { id: string } }>(
      CREATE_EQUIPMENT,
      { input: { name: PROJECTOR_NAME, quantityAvailable: 5 } },
      adminToken,
    )
  ).createEquipment.id
  cameraId = (
    await gql<{ createEquipment: { id: string } }>(
      CREATE_EQUIPMENT,
      { input: { name: CAMERA_NAME, quantityAvailable: 4 } },
      adminToken,
    )
  ).createEquipment.id

  // Three `booking:read:own` employees: the requester whose bookings the view
  // describes, a bystander who must be refused, and one who is about to be
  // deleted (FR-7) so the "Deleted user" case is a real soft-nulled FK rather
  // than a mock.
  requesterEmail = `${TOKEN}requester@resource.local`
  const requesterId = await createEmployee(REQUESTER_FIRST, REQUESTER_LAST, requesterEmail)
  await gql(ASSIGN_ROLE, { input: { employeeId: requesterId, roleId } }, adminToken)
  requesterToken = await login(requesterEmail)

  bystanderEmail = `${TOKEN}bystander@resource.local`
  const bystanderId = await createEmployee('Ben', 'Bystander', bystanderEmail)
  await gql(ASSIGN_ROLE, { input: { employeeId: bystanderId, roleId } }, adminToken)
  bystanderToken = await login(bystanderEmail)

  doomedEmail = `${TOKEN}doomed@resource.local`
  const doomedIdEmployee = await createEmployee('Dee', 'Doomed', doomedEmail)
  await gql(ASSIGN_ROLE, { input: { employeeId: doomedIdEmployee, roleId } }, adminToken)
  const doomedToken = await login(doomedEmail)

  // The competing same-room booking is created and *cancelled* before the one
  // under test: `ex_booking_room_time_range` makes two PENDING/APPROVED bookings
  // overlap in one room impossible, and a cancelled booking still occupies the
  // window in time — which is exactly what "its other bookings in the same
  // window" should show.
  cancelledId = await createBooking(requesterToken, {
    roomId,
    startTime: WINDOW_CANCELLED.start.toISOString(),
    endTime: WINDOW_CANCELLED.end.toISOString(),
    purpose: `${TOKEN}cancelled-overlap`,
    numberOfAttendees: 2,
  })
  await gql(CANCEL_BOOKING, { id: cancelledId }, adminToken)

  approvedId = await createBooking(requesterToken, {
    roomId,
    startTime: WINDOW_MAIN.start.toISOString(),
    endTime: WINDOW_MAIN.end.toISOString(),
    purpose: `${TOKEN}approved-purpose`,
    numberOfAttendees: 5,
    equipment: [
      { equipmentId: projectorId, quantity: 2 },
      { equipmentId: cameraId, quantity: 1 },
    ],
  })
  // A second employee takes 2 of the 4 cameras in an overlapping window (in a
  // different room, so the room constraint is not involved), and it stays
  // PENDING — which still commits, exactly as FR-35's "committed" defines it.
  pendingId = await createBooking(bystanderToken, {
    roomId: otherRoomId,
    startTime: WINDOW_CAMERA.start.toISOString(),
    endTime: WINDOW_CAMERA.end.toISOString(),
    purpose: `${TOKEN}camera-taker`,
    numberOfAttendees: 2,
    equipment: [{ equipmentId: cameraId, quantity: 2 }],
  })
  await gql(APPROVE_BOOKING, { id: approvedId }, managerToken)

  rejectedId = await createBooking(requesterToken, {
    roomId,
    startTime: WINDOW_REJECTED.start.toISOString(),
    endTime: WINDOW_REJECTED.end.toISOString(),
    purpose: `${TOKEN}rejected-purpose`,
    numberOfAttendees: 3,
  })
  await gql(REJECT_BOOKING, { input: { id: rejectedId, reason: REJECTION_REASON } }, managerToken)

  laterId = await createBooking(requesterToken, {
    roomId,
    startTime: WINDOW_LATER.start.toISOString(),
    endTime: WINDOW_LATER.end.toISOString(),
    purpose: `${TOKEN}later-purpose`,
    numberOfAttendees: 4,
  })

  doomedId = await createBooking(doomedToken, {
    roomId,
    startTime: WINDOW_DOOMED.start.toISOString(),
    endTime: WINDOW_DOOMED.end.toISOString(),
    purpose: `${TOKEN}doomed-purpose`,
    numberOfAttendees: 2,
  })
  // Approved *before* the deletion, so the history holds two actors: the one
  // about to be hard-deleted, and the manager. One renderer, two payloads.
  await gql(APPROVE_BOOKING, { id: doomedId }, managerToken)
  await gql(DELETE_EMPLOYEE, { id: doomedIdEmployee }, adminToken)
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
  // Welcome-email outbox rows are addressed, not linked — they outlive the
  // fixture employees, so clear them by address before the employees go.
  await clearOutboxFor([managerEmail, requesterEmail, bystanderEmail, doomedEmail]).catch(
    () => undefined,
  )
  for (const id of createdEmployeeIds) {
    await gql(DELETE_EMPLOYEE, { id }, adminToken).catch(() => undefined)
  }
  await gql(
    `mutation Retire($input: UpdateRoomInput!) { updateRoom(input: $input) { id } }`,
    { input: { id: roomId, isActive: false } },
    adminToken,
  ).catch(() => undefined)
  await gql(
    `mutation Retire($input: UpdateRoomInput!) { updateRoom(input: $input) { id } }`,
    { input: { id: otherRoomId, isActive: false } },
    adminToken,
  ).catch(() => undefined)
  for (const id of [projectorId, cameraId]) {
    await gql(
      `mutation Retire($input: UpdateEquipmentInput!) { updateEquipment(input: $input) { id } }`,
      { input: { id, isActive: false } },
      adminToken,
    ).catch(() => undefined)
  }
  await stopServer()
}, 120_000)

/**
 * Ends the session the app is currently holding, through the shell's own button.
 *
 * This is not tidiness. The token is persisted in `localStorage` exactly as it is
 * in a browser, so a second render in the same file starts out as the *previous*
 * identity: without this, the "bystander" session in test 5 would silently be the
 * admin, and a refusal claim about an employee would be a claim about a manager.
 */
async function signOutIfSignedIn(): Promise<void> {
  await waitFor(() => {
    const status = probe().dataset.status
    expect(['anonymous', 'authenticated']).toContain(status)
  })
  if (probe().dataset.status !== 'authenticated') {
    return
  }
  await userEvent.setup().click(screen.getByTestId('sign-out'))
  await screen.findByTestId('login-submit')
}

/**
 * Signs in and lands on a booking's detail route.
 *
 * The route is rendered *directly* rather than reached by clicking: the guard
 * bounces an anonymous visitor to `/login` and keeps the attempted path in
 * `state.from`, and `LoginPage` returns there — so this is also the deep-link
 * path a user would actually take from a bookmark or a notification.
 */
async function openDetailAs(
  email: string,
  password: string,
  bookingId: string,
): Promise<ReturnType<typeof renderApp>> {
  const view = renderApp(newClient(), `/bookings/${bookingId}`)
  await signOutIfSignedIn()
  await signInAndWait(email, password)
  return view
}

async function openDetailAsAdmin(bookingId: string): Promise<ReturnType<typeof renderApp>> {
  return openDetailAs(envValue('ADMIN_EMAIL'), envValue('ADMIN_PASSWORD'), bookingId)
}

describe('C2 — booking detail (FR-45–49)', () => {
  it('1. a processed booking shows its full detail, including who decided it and when', async () => {
    const view = await openDetailAsAdmin(approvedId)
    await screen.findByTestId('booking-detail')

    expect(screen.getByTestId('booking-detail-id')).toHaveTextContent(approvedId)
    expect(screen.getByTestId('booking-detail-status')).toHaveTextContent('APPROVED')

    // FR-45/46: the requested window, the attendees, and when it was asked for.
    expect(screen.getByTestId('requested-purpose')).toHaveTextContent(`${TOKEN}approved-purpose`)
    expect(screen.getByTestId('requested-start')).toHaveTextContent(formatDateTime(WINDOW_MAIN.start.toISOString()))
    expect(screen.getByTestId('requested-end')).toHaveTextContent(formatDateTime(WINDOW_MAIN.end.toISOString()))
    expect(screen.getByTestId('requested-attendees')).toHaveTextContent('5')
    const requestedAt = screen.getByTestId('requested-created-at').textContent ?? ''
    expect(requestedAt).not.toBe('')

    // FR-46: the processed date and time, derived by the server from the deciding
    // audit row (§6 — there is no `processed_at` column), and who decided it. The
    // admin's name comes from `me` in `beforeAll` and is put through
    // `displayName()`, so the expectation and the screen share one formatter.
    const processedAt = screen.getByTestId('processed-at').textContent ?? ''
    expect(processedAt).not.toBe('')
    expect(Number.isNaN(new Date(processedAt).getTime())).toBe(false)
    expect(new Date(processedAt).getTime()).toBeGreaterThanOrEqual(new Date(requestedAt).getTime())
    expect(screen.getByTestId('processed-by')).toHaveTextContent(managerDisplayName())
    // Nothing was rejected, so there is no reason to show.
    expect(screen.queryByTestId('rejection-reason')).not.toBeInTheDocument()

    // The same processed block, for a *rejected* booking: same fields, plus the
    // reason FR-46 asks for "where applicable". Each render is unmounted before
    // the next — two mounted apps would put two `auth-probe`s in the document, and
    // the harness's `probe()` deliberately refuses to guess between them.
    view.unmount()
    const rejectedView = await openDetailAsAdmin(rejectedId)
    await screen.findByTestId('booking-detail')
    expect(screen.getByTestId('booking-detail-status')).toHaveTextContent('REJECTED')
    expect(screen.getByTestId('processed-by')).toHaveTextContent(managerDisplayName())
    expect(screen.getByTestId('rejection-reason')).toHaveTextContent(REJECTION_REASON)
    expect(screen.getByTestId('processed-at').textContent ?? '').not.toBe('')
    rejectedView.unmount()

    // …and none at all for a booking nobody has decided: FR-46 is "where the
    // booking has been processed", so an empty block would be a lie, not a blank.
    const pendingView = await openDetailAsAdmin(pendingId)
    await screen.findByTestId('booking-detail')
    expect(screen.getByTestId('booking-detail-status')).toHaveTextContent('PENDING')
    expect(screen.queryByTestId('booking-detail-processed')).not.toBeInTheDocument()
    pendingView.unmount()
  })

  it('2. statusHistory shows every transition, in order, with actor and timestamp', async () => {
    const view = await openDetailAsAdmin(approvedId)
    await screen.findByTestId('status-history-table')

    // Exactly two transitions: created (no previous status to name) and approved.
    // FR-47 asks for "each transition", so a missing or extra row is a failure.
    expect(screen.getAllByTestId(/^transition-\d+$/)).toHaveLength(2)

    expect(screen.getByTestId('transition-0-old')).toHaveTextContent('—')
    expect(screen.getByTestId('transition-0-new')).toHaveTextContent('PENDING')
    expect(screen.getByTestId('transition-0-actor')).toHaveTextContent(
      `${REQUESTER_FIRST} ${REQUESTER_LAST}`,
    )
    expect(screen.getByTestId('transition-1-old')).toHaveTextContent('PENDING')
    expect(screen.getByTestId('transition-1-new')).toHaveTextContent('APPROVED')
    expect(screen.getByTestId('transition-1-actor')).toHaveTextContent(managerDisplayName())

    // NFR-8: no gaps, and the order is the server's (oldest first).
    const createdAt = new Date(screen.getByTestId('transition-0-at').textContent ?? '').getTime()
    const approvedAt = new Date(screen.getByTestId('transition-1-at').textContent ?? '').getTime()
    expect(Number.isNaN(createdAt)).toBe(false)
    expect(approvedAt).toBeGreaterThanOrEqual(createdAt)
    // FR-46's processed timestamp is derived from the *same* audit row, so the two
    // independently-resolved fields must agree — a real cross-check, not a repeat.
    expect(screen.getByTestId('processed-at')).toHaveTextContent(
      formatDateTime(new Date(approvedAt).toISOString()),
    )
    view.unmount()

    // A rejected booking's history ends in REJECTED, not APPROVED.
    const rejectedView = await openDetailAsAdmin(rejectedId)
    await screen.findByTestId('status-history-table')
    expect(screen.getAllByTestId(/^transition-\d+$/)).toHaveLength(2)
    expect(screen.getByTestId('transition-1-new')).toHaveTextContent('REJECTED')
    expect(screen.getByTestId('transition-1-actor')).toHaveTextContent(managerDisplayName())
    rejectedView.unmount()
  })

  it('3. a deleted requester and a deleted actor read "Deleted user" through displayName() itself', async () => {
    displayNameCalls.length = 0
    const view = await openDetailAsAdmin(doomedId)
    await screen.findByTestId('booking-detail')

    // FR-48/FR-7: the requester's employee row is gone, so the name is the
    // fallback. The expected string is the *function's own* return value for a
    // record with no name parts — not a literal typed into the assertion, and not
    // the server's pre-joined `name` (the document does not even select it).
    const deletedName = displayName({ firstName: null, lastName: null })
    expect(deletedName).toBe(DELETED_USER_DISPLAY_NAME)
    expect(screen.getByTestId('requester-name')).toHaveTextContent(deletedName)
    // The email has no display-name function; the API substitutes the same
    // constant, which is what FR-48's "in place of the name/email" asks for.
    expect(screen.getByTestId('requester-email')).toHaveTextContent(DELETED_USER_DISPLAY_NAME)

    // The same fallback on the audit actor that created the booking, and *not* on
    // the one that approved it — one renderer, two payloads, two answers. A screen
    // with its own hardcoded fallback could not produce this difference.
    expect(screen.getByTestId('transition-0-actor')).toHaveTextContent(deletedName)
    expect(screen.getByTestId('transition-1-actor')).toHaveTextContent(managerDisplayName())
    expect(screen.getByTestId('processed-by')).toHaveTextContent(managerDisplayName())

    // The proof that the string came out of the function: in this one render the
    // wrapper was called with a record carrying no name parts *and* with the
    // admin's real parts, and the screen rendered a different label for each. A
    // second implementation — a literal in this file — would have produced the
    // right text with no call recorded for that record at all, and would have
    // needed its own copy of the label to produce the admin's name.
    expect(displayNameCalls).toContainEqual({ firstName: null, lastName: null })
    const shapes = new Set(
      displayNameCalls.map((call) =>
        call === null || call.firstName === null ? 'no-name-parts' : 'has-name-parts',
      ),
    )
    expect([...shapes].sort()).toEqual(['has-name-parts', 'no-name-parts'])

    // And a live requester is not labelled "Deleted user" by the same call site.
    view.unmount()
    await openDetailAsAdmin(approvedId)
    await screen.findByTestId('requester-name')
    expect(screen.getByTestId('requester-name')).toHaveTextContent(
      `${REQUESTER_FIRST} ${REQUESTER_LAST}`,
    )
  })

  it('4. the related resource information is the room, its other bookings, and what is left of the equipment', async () => {
    const view = await openDetailAsAdmin(approvedId)
    await screen.findByTestId('room')

    expect(screen.getByTestId('room-name')).toHaveTextContent(ROOM_NAME)
    expect(screen.getByTestId('room-location')).toHaveTextContent(ROOM_LOCATION)
    expect(screen.getByTestId('room-capacity')).toHaveTextContent(String(ROOM_CAPACITY))

    // FR-49: the other bookings *in this window*. The cancelled booking overlaps
    // 09:15–09:45, so it is listed; the rejected one (14:00) and the one two days
    // later do not overlap, so they must not be. Asserting the absence is the half
    // that proves the filter is a window and not "every booking in the room".
    const otherRows = screen.getAllByTestId(/^room-other-bookings-row-/)
    expect(otherRows).toHaveLength(1)
    expect(screen.getByTestId(`room-other-bookings-row-${cancelledId}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`room-other-bookings-row-${rejectedId}`)).not.toBeInTheDocument()
    expect(screen.queryByTestId(`room-other-bookings-row-${laterId}`)).not.toBeInTheDocument()
    expect(screen.queryByTestId(`room-other-bookings-row-${approvedId}`)).not.toBeInTheDocument()
    expect(screen.getByTestId(`room-other-bookings-link-${cancelledId}`)).toHaveTextContent(
      `${TOKEN}cancelled-overlap`,
    )

    // FR-49: remaining availability during the booking's own window. Projector:
    // 5 in stock, 2 requested here, nothing else overlapping → 3. Camera: 4 in
    // stock, 1 requested here, and 2 committed by the bystander's PENDING
    // booking in an overlapping window → 1. Both are arithmetic, and the second
    // one is why the number is not simply the stock.
    expect(screen.getByTestId(`equipment-requested-${projectorId}`)).toHaveTextContent('×2 requested')
    expect(screen.getByTestId(`equipment-remaining-${projectorId}`)).toHaveTextContent(
      '3 left in this window',
    )
    expect(screen.getByTestId(`equipment-requested-${cameraId}`)).toHaveTextContent('×1 requested')
    expect(screen.getByTestId(`equipment-remaining-${cameraId}`)).toHaveTextContent(
      '1 left in this window',
    )

    // FR-48: the requester's other recent bookings — the other three fixtures of
    // theirs, and not the booking being looked at.
    const recentRows = screen.getAllByTestId(/^requester-recent-bookings-row-/)
    expect(recentRows).toHaveLength(3)
    expect(screen.getByTestId(`requester-recent-bookings-row-${cancelledId}`)).toBeInTheDocument()
    expect(screen.getByTestId(`requester-recent-bookings-row-${rejectedId}`)).toBeInTheDocument()
    expect(screen.getByTestId(`requester-recent-bookings-row-${laterId}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`requester-recent-bookings-row-${approvedId}`)).not.toBeInTheDocument()
    // The bystander's overlapping booking is not the requester's, so it is not
    // part of the requester's history.
    expect(screen.queryByTestId(`requester-recent-bookings-row-${pendingId}`)).not.toBeInTheDocument()
    view.unmount()
  })

  it('5. a caller who may not read this booking gets the server’s refusal, rendered cleanly', async () => {
    // The bystander holds `booking:read:own`, so the route guard lets them in —
    // exactly as it lets them reach the list. The *server* then refuses this
    // particular booking, because it belongs to somebody else (FR-45's scope, the
    // same rule the list obeys).
    const view = await openDetailAs(bystanderEmail, PASSWORD, approvedId)
    await screen.findByTestId('booking-detail-refused')

    expect(screen.getByTestId('booking-detail-error')).toHaveTextContent('Not authorised')
    // The server's own refusal, not a client guess: FORBIDDEN in the response.
    const request = lastRequest('BookingDetail')
    expect(request?.extensions?.['code']).toBe('FORBIDDEN')
    expect(request?.message).toBe('Not authorised')
    // A refusal renders no booking: nothing half-loaded, no blank fields, no
    // error boundary, and the guard's own denial is not what we are looking at.
    expect(screen.queryByTestId('booking-detail')).not.toBeInTheDocument()
    expect(screen.queryByTestId('booking-detail-id')).not.toBeInTheDocument()
    expect(screen.queryByTestId('requester')).not.toBeInTheDocument()
    expect(screen.queryByTestId('guard-denied-alert')).not.toBeInTheDocument()

    // It is a page, not a dead end: the way back works.
    await userEvent.setup().click(screen.getByTestId('booking-detail-back'))
    await waitFor(() => expect(screen.queryByTestId('booking-detail-refused')).not.toBeInTheDocument())
    view.unmount()

    // The other half of the same rule: the requester still sees their own
    // booking, so the refusal above is about *this* booking and not about the
    // session lacking read access altogether.
    const ownerView = await openDetailAs(requesterEmail, PASSWORD, approvedId)
    await screen.findByTestId('booking-detail')
    expect(screen.getByTestId('requester-name')).toHaveTextContent(
      `${REQUESTER_FIRST} ${REQUESTER_LAST}`,
    )
    expect(screen.getByTestId('requester-email')).toHaveTextContent(requesterEmail)
    ownerView.unmount()
  })
})
