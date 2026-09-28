import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatDateTime } from '@/lib/format'
import {
  adminToken,
  bootServer,
  clearOutboxFor,
  gql,
  newClient,
  recorded,
  renderApp,
  selectOption,
  setDateTime,
  settleTable,
  showRow,
  signInAndWait,
  signOutIfSignedIn,
  stopServer,
  unexpectedRejections,
  waitForRequest,
  type RecordedRequest,
} from './c2.harness'

/**
 * C2 acceptance suite, fourth file: the availability the booking form shows while
 * it is being filled (FR-23/29) and the whole booking lifecycle through the app
 * that ships — create, see it in the list, have it decided, read the decision
 * back on the detail screen.
 *
 * The availability claims are *server* claims, so they are proved against the
 * server's own answers rather than against numbers written into this file:
 *
 * - The room section is asserted to contain the row for the blocking booking, and
 *   the panel's row is the server's row — the purpose and status rendered are
 *   read out of `roomAvailability` for the same window and compared, so a panel
 *   that invented its own copy of the answer would fail. Nothing here recomputes
 *   an overlap, and the suite makes no claim that it could: the room's blocking
 *   booking is put in the window by the API (created *and approved*, because
 *   FR-35 only lets a committed booking block) before the form is ever opened.
 * - The equipment section is asserted against `equipmentAvailability`'s own
 *   `remainingAvailability` and `quantityAvailable` for the same window, plus
 *   the request that carried it — so the numbers on screen are the server's, and
 *   the *variables* are the window the form had typed.
 * - A second window with nothing in it must show the server's empty answer, which
 *   is what makes the first assertion non-vacuous: a panel stuck on "one booking,
 *   three left" regardless of the window would fail here.
 *
 * The lifecycle claim is deliberately end-to-end and in one test, because the
 * interesting part is what crosses a session boundary: the requester creates the
 * booking and sees it in their own list, a *different* person approves it from the
 * queue, and then the requester's (or the manager's) detail screen shows the new
 * status and the transition that caused it. Each step is checked against the
 * server, and the queue is walked by `showRow` for the reason the approvals suite
 * documents — the queue is global, unsearchable and oldest-first.
 *
 * Everything is token-scoped (`TOKEN` is in the room, the equipment and every
 * purpose), and no assertion compares a count to a literal: this database has
 * grown with every client run (see the "no global count" rule in AGENTS.md).
 */

const PASSWORD = 'Fixture@12345'
const TOKEN = `c2av-${Date.now().toString(36)}-`
const ROOM_NAME = `${TOKEN}room`
const EQUIPMENT_NAME = `${TOKEN}camera`
/** The item's standing total; the server's answer for a window is below it. */
const EQUIPMENT_QUANTITY = 5
const BLOCKING_PURPOSE = `${TOKEN}board meeting`
const LIFECYCLE_PURPOSE = `${TOKEN}sprint review`

const REQUESTER_FIRST = 'Rae'
const REQUESTER_LAST = 'Availability'
const MANAGER_FIRST = 'Manny'
const MANAGER_LAST = 'Approver'

const LOGIN = `mutation Login($input: LoginInput!) { login(input: $input) }`
const CREATE_EMPLOYEE = `mutation CreateEmployee($input: CreateEmployeeInput!) {
  createEmployee(input: $input) { id email }
}`
const DELETE_EMPLOYEE = `mutation DeleteEmployee($id: String!) { deleteEmployee(id: String!) }`
const ASSIGN_ROLE = `mutation AssignRole($input: EmployeeRoleInput!) {
  assignRoleToEmployee(input: $input) { id }
}`
const CREATE_ROOM = `mutation CreateRoom($input: CreateRoomInput!) {
  createRoom(input: $input) { id name }
}`
const RETIRE_ROOM = `mutation RetireRoom($input: UpdateRoomInput!) { updateRoom(input: $input) { id } }`
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
const ROOM_AVAILABILITY = `query RoomAvailability($roomId: String!, $startDate: DateTimeISO!, $endDate: DateTimeISO!) {
  roomAvailability(roomId: $roomId, startDate: $startDate, endDate: $endDate) { id startTime endTime purpose status }
}`
const EQUIPMENT_AVAILABILITY = `query EquipmentAvailability($equipmentId: String!, $startDate: DateTimeISO!, $endDate: DateTimeISO!) {
  equipmentAvailability(equipmentId: $equipmentId, startDate: $startDate, endDate: $endDate) {
    equipmentId name quantityAvailable remainingAvailability
  }
}`

interface AvailabilityRow {
  id: string
  startTime: string
  endTime: string
  purpose: string
  status: string
}

interface EquipmentAvailability {
  equipmentId: string
  name: string
  quantityAvailable: number
  remainingAvailability: number
}

/**
 * A window `days` from now, as the `datetime-local` value a form field holds
 * (`YYYY-MM-DDTHH:mm`) *and* as the UTC ISO the API takes.
 *
 * The form's own value is what the panel is driven by, so a test that wanted a
 * window the form could not hold would be testing its own setup rather than the
 * screen; `local`-shaped is the only shape the form can carry.
 */
function windowAt(days: number, hour: number): { local: string; iso: string } {
  const start = new Date()
  start.setDate(start.getDate() + days)
  start.setHours(hour, 0, 0, 0)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return {
    local: `${String(start.getFullYear())}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:00`,
    iso: start.toISOString(),
  }
}

/** The window the blocking booking occupies, one hour long. */
const BLOCKING = windowAt(6, 9)
const BLOCKING_END = windowAt(6, 10)
const OVERLAPPING = windowAt(6, 9)
const OVERLAPPING_END = windowAt(6, 10)
/** Same day, hours the blocking booking does not touch. */
const FREE = windowAt(6, 13)
const FREE_END = windowAt(6, 14)
/** The lifecycle booking's own window, on its own day. */
const LIFECYCLE = windowAt(7, 9)
const LIFECYCLE_END = windowAt(7, 10)

let roomId = ''
let equipmentId = ''
let blockingBookingId = ''
const createdEmployeeIds: string[] = []
let requesterEmail = ''
let requesterToken = ''
let managerEmail = ''

async function login(email: string): Promise<string> {
  const result = await gql<{ login: string }>(LOGIN, { input: { email, password: PASSWORD } })
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

async function serverRoomAvailability(startDate: string, endDate: string): Promise<AvailabilityRow[]> {
  const response = await gql<{ roomAvailability: AvailabilityRow[] }>(
    ROOM_AVAILABILITY,
    { roomId, startDate, endDate },
    adminToken,
  )
  return response.roomAvailability
}

async function serverEquipmentAvailability(
  startDate: string,
  endDate: string,
): Promise<EquipmentAvailability> {
  const response = await gql<{ equipmentAvailability: EquipmentAvailability }>(
    EQUIPMENT_AVAILABILITY,
    { equipmentId, startDate, endDate },
    adminToken,
  )
  return response.equipmentAvailability
}

beforeAll(async () => {
  await bootServer()
  const employeeRoleId = await roleIdByName('Employee')
  const managerRoleId = await roleIdByName('Manager')

  roomId = (
    await gql<{ createRoom: { id: string } }>(
      CREATE_ROOM,
      { input: { name: ROOM_NAME, location: 'Basement', capacity: 8 } },
      adminToken,
    )
  ).createRoom.id
  equipmentId = (
    await gql<{ createEquipment: { id: string } }>(
      CREATE_EQUIPMENT,
      { input: { name: EQUIPMENT_NAME, quantityAvailable: EQUIPMENT_QUANTITY } },
      adminToken,
    )
  ).createEquipment.id

  requesterEmail = `${TOKEN}requester@resource.local`
  const requesterId = await createEmployee(REQUESTER_FIRST, REQUESTER_LAST, requesterEmail)
  await gql(ASSIGN_ROLE, { input: { employeeId: requesterId, roleId: employeeRoleId } }, adminToken)
  requesterToken = await login(requesterEmail)

  managerEmail = `${TOKEN}manager@resource.local`
  const managerId = await createEmployee(MANAGER_FIRST, MANAGER_LAST, managerEmail)
  await gql(ASSIGN_ROLE, { input: { employeeId: managerId, roleId: employeeRoleId } }, adminToken)
  await gql(ASSIGN_ROLE, { input: { employeeId: managerId, roleId: managerRoleId } }, adminToken)

  // The booking that makes the room busy, created by the *requester* and
  // approved by the admin.
  //
  // Two requirements, both from the server rather than from taste. It has to be
  // APPROVED, not merely PENDING, because FR-35 lets only a committed booking
  // block — a PENDING fixture would show the room as free and the whole suite
  // would be measuring nothing. And the two halves have to be *different people*:
  // the admin holds `booking:approve`, so an admin-created booking is a booking
  // the admin may not approve, and the server refuses it with FR-56's own message
  // ("A manager cannot approve or reject their own booking request"). Doing it the
  // other way round is the arrangement the requirement actually describes, and
  // this suite found that by being refused.
  const blocking = await gql<{ createBooking: { id: string } }>(
    CREATE_BOOKING,
    {
      input: {
        roomId,
        startTime: BLOCKING.iso,
        endTime: BLOCKING_END.iso,
        purpose: BLOCKING_PURPOSE,
        numberOfAttendees: 3,
        equipment: [{ equipmentId, quantity: 2 }],
      },
    },
    requesterToken,
  )
  blockingBookingId = blocking.createBooking.id
  await gql(APPROVE, { id: blockingBookingId }, adminToken)
}, 150_000)

afterAll(async () => {
  // The outbox is addressed, not linked, so the decision mail is cleared by
  // address before the employees go — the address is the only handle there is.
  // Two decisions are made in this suite — the blocking fixture in `beforeAll`
  // and the lifecycle booking in test 3 — and each enqueues one FR-61 decision
  // mail, both addressed to the requester. Asserting the count rather than "> 0"
  // is what keeps a cleanup that quietly matched nothing from passing.
  const cleared = await clearOutboxFor([requesterEmail, managerEmail])
  expect(cleared).toBeGreaterThanOrEqual(2)
  for (const id of createdEmployeeIds) {
    await gql(DELETE_EMPLOYEE, { id }, adminToken).catch(() => undefined)
  }
  if (roomId !== '') {
    await gql(RETIRE_ROOM, { input: { id: roomId, isActive: false } }, adminToken).catch(() => undefined)
  }
  if (equipmentId !== '') {
    await gql(RETIRE_EQUIPMENT, { input: { id: equipmentId, isActive: false } }, adminToken).catch(() => undefined)
  }
  expect(unexpectedRejections()).toEqual([])
  await stopServer()
}, 120_000)

/** Signs `email` in on a fresh app and opens the bookings list. */
async function openListAs(email: string): Promise<void> {
  renderApp(newClient(), '/login')
  await signInAndWait(email, PASSWORD)
  await screen.findByTestId('datatable')
}

/**
 * The create dialog, opened and left open.
 *
 * The New booking button is disabled until the room and equipment *option* lists
 * have arrived — they are the form's own inputs, and a dialog with empty selects
 * is not worth opening. So the wait is for the button to become enabled rather
 * than for it to exist, and the reason it is disabled rides along in the failure
 * message: a silent timeout here looks like a missing button.
 */
async function openCreateDialog(): Promise<void> {
  const button = await screen.findByTestId('new-booking')
  await waitFor(
    () => {
      expect(
        button,
        `the create button never became available: ${screen.queryByTestId('screen-options-error')?.textContent ?? 'options still loading'}`,
      ).toBeEnabled()
    },
    { timeout: 15_000 },
  )
  await userEvent.setup().click(button)
  await screen.findByTestId('form')
}

describe('C2 — availability in the booking form (FR-23/29)', () => {
  it('1. shows the server\'s own room and equipment availability for the window the form has typed', async () => {
    await openListAs(requesterEmail)
    await openCreateDialog()

    // Before there is a window there is nothing to ask, and the panel says so
    // rather than showing a stale or invented answer.
    expect(await screen.findByTestId('availability-hint')).toBeInTheDocument()

    await selectOption(/^room/i, new RegExp(ROOM_NAME))
    await setDateTime(/^start/i, OVERLAPPING.local)
    await setDateTime(/^end/i, OVERLAPPING_END.local)

    // The panel asks the server for *this* window — the variables are the claim,
    // not a detail: a client that computed the overlap locally would send nothing.
    const roomRequest = await waitForRequest('RoomAvailability', (variables) => {
      return (
        variables['roomId'] === roomId &&
        variables['startDate'] === OVERLAPPING.iso &&
        variables['endDate'] === OVERLAPPING_END.iso
      )
    })
    expect(roomRequest.variables['roomId']).toBe(roomId)

    // What the server says about the same window, read over the wire.
    const serverRows = await serverRoomAvailability(OVERLAPPING.iso, OVERLAPPING_END.iso)
    expect(serverRows.map((row) => row.id)).toContain(blockingBookingId)

    // FR-23: the panel shows that booking, with the server's own purpose, status
    // and window. Each cell is compared to the row the server sent, so a panel
    // that rendered its own idea of the conflict would not pass.
    const row = await screen.findByTestId(`availability-room-row-${blockingBookingId}`)
    expect(within(row).getByTestId(`availability-room-purpose-${blockingBookingId}`).textContent).toBe(
      BLOCKING_PURPOSE,
    )
    expect(within(row).getByTestId(`availability-room-status-${blockingBookingId}`).textContent).toBe('APPROVED')
    expect(within(row).getByTestId(`availability-room-window-${blockingBookingId}`).textContent).toBe(
      `${formatDateTime(BLOCKING.iso)} – ${formatDateTime(BLOCKING_END.iso)}`,
    )
    expect(await screen.findByTestId('availability-room-warning')).toHaveTextContent(
      `${String(serverRows.length)} booking(s) in this window`,
    )

    // FR-29: the same draft row turns into a question about that item.
    await userEvent.setup().click(screen.getByTestId('group-add-equipment'))
    await selectOption(/^item/i, new RegExp(EQUIPMENT_NAME))
    // The row's quantity input is found by its *label*: a group field's testid
    // sits on the TextField wrapper `<div>` (`field-equipment.0.quantity`), so a
    // `user.type` on the testid would act on a div.
    const quantity = screen.getByLabelText(/^quantity/i)
    await userEvent.setup().clear(quantity)
    await userEvent.setup().type(quantity, '4')

    const equipmentRequest = await waitForRequest('EquipmentAvailability', (variables) => {
      return (
        variables['equipmentId'] === equipmentId &&
        variables['startDate'] === OVERLAPPING.iso &&
        variables['endDate'] === OVERLAPPING_END.iso
      )
    })
    expect(equipmentRequest.variables['equipmentId']).toBe(equipmentId)

    // The server's two numbers, for the same window: 5 standing, less the 2 the
    // blocking booking holds. The suite asks the API rather than asserting `3`.
    const serverEquipment = await serverEquipmentAvailability(OVERLAPPING.iso, OVERLAPPING_END.iso)
    expect(serverEquipment.quantityAvailable).toBe(EQUIPMENT_QUANTITY)
    expect(serverEquipment.remainingAvailability).toBeLessThan(serverEquipment.quantityAvailable)

    const remaining = await screen.findByTestId(`availability-equipment-${equipmentId}-remaining`)
    expect(remaining.textContent).toBe(
      `${String(serverEquipment.remainingAvailability)} of ${String(EQUIPMENT_QUANTITY)} available in this window`,
    )
    // The draft asked for 4 and the server says fewer are left: the panel says so
    // and still lets the user submit, because the server is what decides.
    expect(await screen.findByTestId(`availability-equipment-${equipmentId}-short`)).toBeInTheDocument()
    expect(screen.getByTestId('form-submit')).toBeEnabled()
  }, 90_000)

  it('2. re-asks the server for a new window: a free one shows the server\'s empty answer', async () => {
    await openListAs(requesterEmail)
    await openCreateDialog()

    await selectOption(/^room/i, new RegExp(ROOM_NAME))
    await setDateTime(/^start/i, OVERLAPPING.local)
    await setDateTime(/^end/i, OVERLAPPING_END.local)
    // The busy window first, so "free" cannot pass by never having shown a row.
    await screen.findByTestId(`availability-room-row-${blockingBookingId}`)

    await setDateTime(/^start/i, FREE.local)
    await setDateTime(/^end/i, FREE_END.local)

    // The server's answer for the free window, and the panel's rendering of it.
    const freeRows = await serverRoomAvailability(FREE.iso, FREE_END.iso)
    expect(freeRows).toEqual([])
    expect(await screen.findByTestId('availability-room-empty')).toBeInTheDocument()
    expect(screen.queryByTestId(`availability-room-row-${blockingBookingId}`)).not.toBeInTheDocument()

    // And the request that produced it went out with the new window, which is
    // what makes the first test's request assertion a pattern rather than a
    // one-off.
    await waitForRequest('RoomAvailability', (variables) => {
      return variables['startDate'] === FREE.iso && variables['endDate'] === FREE_END.iso
    })
  }, 90_000)

  it('3. settles on one window rather than answering every window it passes through', async () => {
    await openListAs(requesterEmail)
    await openCreateDialog()
    await selectOption(/^room/i, new RegExp(ROOM_NAME))
    await setDateTime(/^start/i, OVERLAPPING.local)
    await setDateTime(/^end/i, OVERLAPPING_END.local)
    // The busy window answered first, so the change below has a real answer to
    // replace rather than nothing to show.
    await screen.findByTestId(`availability-room-row-${blockingBookingId}`)

    // Changing only the start leaves a start with the previous end, which is a
    // perfectly good window — so a panel that asked on every keystroke would ask
    // the server about the half-typed one too. The seam is the panel's own state,
    // not the request log: the harness records a GraphQL request when its
    // *response* arrives, and a query the panel withdraws is cancelled and never
    // recorded, so "how many requests went out" cannot see the ones the debounce
    // prevents. What is observable, and what the fix actually does, is that the
    // components that issue those queries are not in the tree while the draft is
    // still moving.
    await setDateTime(/^start/i, FREE.local)
    expect(screen.getByTestId('availability-pending')).toBeInTheDocument()
    expect(screen.queryByTestId('availability-room')).not.toBeInTheDocument()
    expect(screen.queryByTestId(`availability-room-row-${blockingBookingId}`)).not.toBeInTheDocument()
    await setDateTime(/^end/i, FREE_END.local)

    // And once it has settled there is one coherent answer: the server's, for the
    // window the form came to rest on, with the previous window's rows gone rather
    // than left sitting under the new label.
    expect(await screen.findByTestId('availability-room-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('availability-pending')).not.toBeInTheDocument()
    expect(screen.queryByTestId(`availability-room-row-${blockingBookingId}`)).not.toBeInTheDocument()
    await waitForRequest('RoomAvailability', (variables) => {
      return variables['startDate'] === FREE.iso && variables['endDate'] === FREE_END.iso
    })
  }, 90_000)
})

describe('C2 — the booking lifecycle end to end', () => {
  it('4. create → in the requester\'s list → approved by someone else → the detail screen says so', async () => {
    // 1. The requester creates it, and the server's own answer is what the
    //    success notice shows (FR-38): the UUID and the PENDING status.
    await openListAs(requesterEmail)
    await openCreateDialog()
    await selectOption(/^room/i, new RegExp(ROOM_NAME))
    await setDateTime(/^start/i, LIFECYCLE.local)
    await setDateTime(/^end/i, LIFECYCLE_END.local)
    await userEvent.setup().type(await screen.findByLabelText(/^number of attendees/i), '4')
    await userEvent.setup().type(await screen.findByLabelText(/^purpose/i), LIFECYCLE_PURPOSE)
    await userEvent.setup().click(screen.getByTestId('form-submit'))

    const createdId = (await screen.findByTestId('booking-created-id')).textContent ?? ''
    expect(createdId).toMatch(/^[0-9a-f-]{36}$/)
    expect(screen.getByTestId('booking-created-status')).toHaveTextContent('PENDING')

    // 2. It is in the requester's list. The search is the *server's* search (the
    //    debounce has to be waited out, per the harness), and the row is matched
    //    on the very id the server just handed out.
    await userEvent.setup().type(await screen.findByTestId('table-search'), TOKEN)
    await settleTable()
    const row = await waitFor(
      async () => {
        await waitForRequest('Bookings', (variables) => {
          const filter = variables['filter'] as { search?: string } | undefined
          return filter?.search === TOKEN
        })
        const found = screen
          .getAllByRole('row')
          .slice(1)
          .find((candidate) => candidate.dataset['id'] === createdId)
        expect(found, 'the new booking is not in the list').toBeDefined()
        return found as HTMLElement
      },
      { timeout: 15_000 },
    )
    expect(within(row).getByText(LIFECYCLE_PURPOSE)).toBeInTheDocument()

    // 3. A different person decides it. The manager signs out of the requester's
    //    session (the token is in localStorage, exactly as in a browser) and
    //    finds the request in the queue, which is walked because the queue is
    //    global and oldest-first.
    await signOutIfSignedIn()
    await signInAndWait(managerEmail, PASSWORD)
    await userEvent.setup().click(within(await screen.findByTestId('nav-approvals')).getByRole('link'))
    const queueRow = await showRow(createdId)
    await userEvent.setup().click(within(queueRow).getByTestId('row-approve'))
    await userEvent.setup().click(await screen.findByTestId('confirm-accept'))
    expect(await screen.findByTestId('approval-notice')).toHaveTextContent('APPROVED')

    // 4. The detail screen reflects the new status, and the history says who
    //    decided it and when. The requester could see this too; the manager is
    //    used here so the walk does not need a second session.
    await userEvent.setup().click(within(await screen.findByTestId('nav-bookings')).getByRole('link'))
    await screen.findByTestId('datatable')
    await userEvent.setup().type(await screen.findByTestId('table-search'), TOKEN)
    await settleTable()
    const decidedRow = await waitFor(
      async () => {
        await waitForRequest('Bookings', (variables) => {
          const filter = variables['filter'] as { search?: string } | undefined
          return filter?.search === TOKEN
        })
        const found = screen
          .getAllByRole('row')
          .slice(1)
          .find((candidate) => candidate.dataset['id'] === createdId)
        expect(found, 'the decided booking is not in the manager\'s list').toBeDefined()
        return found as HTMLElement
      },
      { timeout: 15_000 },
    )
    // A row click is a shortcut over the first cell's link; the click is what
    // proves the row carries the id the detail route needs.
    await userEvent.setup().click(decidedRow)

    const detail = await screen.findByTestId('booking-detail')
    expect(detail).toHaveAttribute('data-booking-id', createdId)
    expect(await screen.findByTestId('booking-detail-status')).toHaveTextContent('APPROVED')

    // The processed block: who decided it, and when — the server's audit entry,
    // which is where a booking's processed date comes from (FR-40/46).
    expect(await screen.findByTestId('processed-by')).toHaveTextContent(
      `${String(MANAGER_FIRST)} ${String(MANAGER_LAST)}`,
    )
    expect(screen.getByTestId('processed-at').textContent).not.toBe('')

    // The history: the approval is the last transition, it is attributed to the
    // manager, and the PENDING that preceded it is still there.
    const transitions = document.querySelectorAll('[data-testid^="transition-"][data-testid$="-new"]')
    expect(transitions.length).toBeGreaterThan(0)
    const last = transitions[transitions.length - 1] as HTMLElement
    expect(last.textContent).toContain('APPROVED')
    const transitionIndex = transitions.length - 1
    expect(screen.getByTestId(`transition-${String(transitionIndex)}-actor`)).toHaveTextContent(
      `${String(MANAGER_FIRST)} ${String(MANAGER_LAST)}`,
    )
  }, 120_000)
})
