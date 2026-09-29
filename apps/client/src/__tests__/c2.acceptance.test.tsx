import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminToken,
  bootServer,
  clearOutboxFor,
  CLIENT_ROOT,
  dataRowTexts,
  dataRows,
  envValue,
  gql,
  newClient,
  lastRequest,
  probe,
  recorded,
  renderApp,
  selectOption,
  setDateTime,
  settleTable,
  signInAndWait,
  stopServer,
  unexpectedRejections,
  waitForRequest,
} from './c2.harness'

/**
 * C2 acceptance suite, first half: booking create and booking list, against a
 * real server, driven through the app that ships (`AppProviders` → `AppRoutes`).
 *
 * The five claims below are the ones this half makes:
 *   1. a successful create shows the booking's UUID and the server's PENDING
 *      status (FR-38);
 *   2. a refused create renders the server's own reason, and the client-side
 *      rules are the same rules the server enforces;
 *   3. the list renders through the *same* `DataTable` — and the create dialog
 *      through the *same* `Form` — that C1 proved reused;
 *   4. a `booking:read:own` session sees its own bookings and nothing else,
 *      because the client renders the scoped page the server returned and
 *      nothing more (FR-39, NFR-5);
 *   5. search and every filter reach the server as GraphQL variables (FR-41/42).
 *
 * The fixtures are deliberately small and named (`c2-<run>-…`) so every assertion
 * below is about a row this suite created, never about whatever the dev database
 * happens to contain. That is not tidiness: there is no `deleteBooking`, so a
 * shared dev database keeps every run's fixtures forever, and an *unscoped* claim
 * like "the new booking is on page 1" starts failing once the accumulated rows
 * outnumber a page. Every grid assertion here is therefore scoped to this run's
 * token, and the unscoped claims are only ever about the request that was sent —
 * which is the part the client actually controls (NFR-7).
 */

const PASSWORD = 'Fixture@12345'
/**
 * Every fixture is stamped with this run's token. The database is shared with a
 * dev server and there is no `deleteBooking`, so a fixed purpose would mean every
 * run of this suite leaves another row matching the same search — and the second
 * run's "exactly one row" assertions would fail on the *first* run's leftovers.
 * (The same reason C1's employee addresses carry a per-run suffix.)
 */
const TOKEN = `c2-${Date.now().toString(36)}-`
const ROOM_NAME = `${TOKEN}room`
const EQUIPMENT_NAME = `${TOKEN}projector`

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
  createBooking(input: $input) { id status requester { id } }
}`
const LIST_BOOKINGS = `query List($filter: BookingFilterInput) {
  bookings(page: 1, pageSize: 50, filter: $filter) {
    totalCount
    items {
      id status purpose startTime endTime numberOfAttendees
      requester { id name }
      room { id name }
      equipmentLines { equipmentId name requestedQuantity }
    }
  }
}`

interface Slot {
  start: Date
  end: Date
  startInput: string
  endInput: string
}

/** A `datetime-local` value in the runner's own zone, for the browser's input. */
function toInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Whole hours, `days` from now, so no fixture booking is ever in the past. */
function slot(days: number, hour: number): Slot {
  const start = new Date()
  start.setDate(start.getDate() + days)
  start.setHours(hour, 0, 0, 0)
  const end = new Date(start)
  end.setHours(hour + 1, 0, 0, 0)
  return { start, end, startInput: toInput(start), endInput: toInput(end) }
}

function dayOf(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const SLOT_A = slot(3, 9) // the create screen's default window, and the overlap's
const SLOT_D = slot(3, 14) // the own-booking fixture (must not clash with A)
const SLOT_B = slot(5, 9) // search / date-filter fixture
const SLOT_C = slot(5, 14) // the "somebody else's booking" fixture

const createdEmployeeIds: string[] = []
let roomId = ''
let equipmentId = ''
/** A `booking:read:own` session: the seeded Employee role. */
let ownerEmail = ''
/** A second employee: the requester of the bookings the owner must not see. */
let otherEmail = ''
let otherToken = ''
/** Booked by the second employee in `beforeAll`; the search/date-filter target. */
let equipmentBookingId = ''
/** Booked by the second employee in `beforeAll`; must never appear in the owner's list. */
let otherBookingId = ''
let otherBookingPurpose = ''
/** Created through the screen in test 1, which test 2 then collides with. */
let uiBookingId = ''
let uiBookingPurpose = ''

async function createEmployee(first: string, last: string, email: string): Promise<string> {
  const created = await gql<{ createEmployee: { id: string } }>(
    CREATE_EMPLOYEE,
    { input: { firstName: first, lastName: last, email, password: PASSWORD } },
    adminToken,
  )
  createdEmployeeIds.push(created.createEmployee.id)
  return created.createEmployee.id
}

async function createBooking(
  token: string,
  input: {
    roomId: string
    startTime: string
    endTime: string
    purpose: string
    numberOfAttendees: number
    equipment?: { equipmentId: string; quantity: number }[]
  },
): Promise<string> {
  const created = await gql<{ createBooking: { id: string } }>(CREATE_BOOKING, { input }, token)
  return created.createBooking.id
}

beforeAll(async () => {
  await bootServer()

  const room = await gql<{ createRoom: { id: string } }>(
    CREATE_ROOM,
    { input: { name: ROOM_NAME, location: 'North', capacity: 40 } },
    adminToken,
  )
  roomId = room.createRoom.id
  const equipment = await gql<{ createEquipment: { id: string } }>(
    CREATE_EQUIPMENT,
    { input: { name: EQUIPMENT_NAME, quantityAvailable: 4 } },
    adminToken,
  )
  equipmentId = equipment.createEquipment.id

  // Two `booking:read:own` employees. The admin no longer holds
  // `booking:create` — booking is the Employee's job — so the bookings the
  // owner must not see belong to a *second* employee: still unambiguously not
  // the session's, and created by a token the suite is allowed to use.
  const roles = await gql<{ roles: { items: { id: string; roleName: string }[] } }>(
    `query { roles { items { id roleName } } }`,
    {},
    adminToken,
  )
  const employeeRole = roles.roles.items.find((role) => role.roleName === 'Employee')
  if (employeeRole === undefined) {
    throw new Error('seeded Employee role is missing')
  }
  ownerEmail = `${TOKEN}owner@resource.local`
  const ownerId = await createEmployee('Ola', 'Owner', ownerEmail)
  await gql(ASSIGN_ROLE, { input: { employeeId: ownerId, roleId: employeeRole.id } }, adminToken)
  otherEmail = `${TOKEN}other@resource.local`
  const otherId = await createEmployee('Ana', 'Other', otherEmail)
  await gql(ASSIGN_ROLE, { input: { employeeId: otherId, roleId: employeeRole.id } }, adminToken)
  otherToken = (
    await gql<{ login: string }>(
      `mutation Login($input: LoginInput!) { login(input: $input) }`,
      { input: { email: otherEmail, password: PASSWORD } },
    )
  ).login

  // Two bookings owned by the second employee, in the same room at different
  // hours, so no exclusion-constraint conflict is possible between fixtures. The
  // first has an equipment line, which is what makes FR-41's `EXISTS` over
  // `booking_equipment` observable: the equipment's *name* finds it, and no
  // visible column says so.
  equipmentBookingId = await createBooking(otherToken, {
    roomId,
    startTime: SLOT_B.start.toISOString(),
    endTime: SLOT_B.end.toISOString(),
    purpose: `${TOKEN}with-equipment`,
    numberOfAttendees: 6,
    equipment: [{ equipmentId, quantity: 2 }],
  })
  otherBookingPurpose = `${TOKEN}other-purpose`
  otherBookingId = await createBooking(otherToken, {
    roomId,
    startTime: SLOT_C.start.toISOString(),
    endTime: SLOT_C.end.toISOString(),
    purpose: otherBookingPurpose,
    numberOfAttendees: 4,
  })

  recorded.length = 0
}, 180_000)

afterAll(() => {
  // The harness allowlists two Apollo-internal throws; this is the assertion
  // that makes that list mean something.
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
  // The fixture employees are created through the mutation, so each one
  // enqueues a welcome email. The outbox is addressed, not linked — those rows
  // outlive the employees, so clear them by address before the employees go.
  await clearOutboxFor([ownerEmail, otherEmail]).catch(() => undefined)
  for (const id of createdEmployeeIds) {
    await gql(DELETE_EMPLOYEE, { id }, adminToken).catch(() => undefined)
  }
  // There is no deleteBooking, exactly as there is no deleteRoom: the room is
  // retired so it stops being offered, which is also the state a real
  // deactivation leaves behind.
  await gql(
    `mutation Retire($input: UpdateRoomInput!) { updateRoom(input: $input) { id } }`,
    { input: { id: roomId, isActive: false } },
    adminToken,
  ).catch(() => undefined)
  await gql(
    `mutation Retire($input: UpdateEquipmentInput!) { updateEquipment(input: $input) { id } }`,
    { input: { id: equipmentId, isActive: false } },
    adminToken,
  ).catch(() => undefined)
  await stopServer()
}, 120_000)

/** Signs in as the admin and lands on the bookings screen. */
async function openBookingsAsAdmin(): Promise<ReturnType<typeof renderApp>> {
  const view = renderApp(newClient(), '/login')
  await signInAndWait(envValue('ADMIN_EMAIL'), envValue('ADMIN_PASSWORD'))
  const user = userEvent.setup()
  // The testid is on the <li>; the link is inside it, and a click on the <li>
  // never reaches a child in the DOM.
  await user.click(within(await screen.findByTestId('nav-bookings')).getByRole('link'))
  await screen.findByTestId('datatable')
  return view
}

/**
 * Signs in as the owner employee and lands on the bookings screen. The create
 * dialog is driven in this session rather than the admin's because the admin no
 * longer holds `booking:create` — booking is the Employee's job — so a create
 * the suite performs has to be one the server will accept.
 */
async function openBookingsAsOwner(): Promise<ReturnType<typeof renderApp>> {
  const view = renderApp(newClient(), '/login')
  await signInAndWait(ownerEmail, PASSWORD)
  const user = userEvent.setup()
  await user.click(within(await screen.findByTestId('nav-bookings')).getByRole('link'))
  await screen.findByTestId('datatable')
  return view
}

/**
 * Opens the create dialog. The button is disabled until the room and equipment
 * option lists have loaded, which is why this waits rather than clicks.
 */
async function openCreateDialog(): Promise<void> {
  const button = await screen.findByTestId('new-booking')
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.setup().click(button)
  await screen.findByTestId('form')
}

/** Fills a valid booking form, optionally with one equipment line. */
async function fillBookingForm(options: {
  purpose: string
  attendees?: string
  start?: string
  end?: string
  equipment?: { item: RegExp; quantity: string }
}): Promise<void> {
  await selectOption(/^room/i, new RegExp(ROOM_NAME))
  await setDateTime(/^start/i, options.start ?? SLOT_A.startInput)
  await setDateTime(/^end/i, options.end ?? SLOT_A.endInput)
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText(/number of attendees/i), options.attendees ?? '5')
  await user.type(await screen.findByLabelText(/^purpose/i), options.purpose)
  if (options.equipment !== undefined) {
    await user.click(await screen.findByTestId('group-add-equipment'))
    const row = await screen.findByTestId('group-row-equipment-0')
    await selectOption(/^item/i, options.equipment.item)
    // The quantity is found by its label, not by the group's testid: a
    // `FormField`'s testid is on the `TextField` root, and typing into a `<div>`
    // is a no-op that would look like a passing test.
    await user.type(within(row).getByLabelText(/quantity/i), options.equipment.quantity)
  }
}

describe('C2 — booking create and booking list', () => {
  it('1. a successful create shows the booking UUID and the server’s PENDING status (FR-38)', async () => {
    const view = await openBookingsAsOwner()
    await openCreateDialog()
    uiBookingPurpose = `${TOKEN}created`
    await fillBookingForm({
      purpose: uiBookingPurpose,
      equipment: { item: new RegExp(EQUIPMENT_NAME), quantity: '2' },
    })

    await userEvent.setup().click(screen.getByTestId('form-submit'))

    // The dialog closes, and what replaces it is the created booking: its UUID
    // and the status the *server* assigned.
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    await screen.findByTestId('booking-created')
    const id = (await screen.findByTestId('booking-created-id')).textContent?.trim() ?? ''
    const status = screen.getByTestId('booking-created-status').textContent?.trim() ?? ''

    // FR-38: a UUID, not a row number or a database id.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(status).toBe('PENDING')
    // …and it is the server's answer that is on screen, not a hardcoded string.
    expect(screen.getByTestId('booking-created-summary')).toHaveTextContent(uiBookingPurpose)
    uiBookingId = id

    // Read back over the API with the admin's token: same id, same status, same
    // purpose, and the equipment line the form's group produced.
    const stored = await gql<{
      bookings: { items: { id: string; status: string; purpose: string; room: { id: string }; equipmentLines: { name: string; requestedQuantity: number }[] }[] }
    }>(LIST_BOOKINGS, { filter: { search: uiBookingPurpose } }, adminToken)
    const found = stored.bookings.items.find((item) => item.id === id)
    expect(found).toBeDefined()
    expect(found?.status).toBe(status)
    expect(found?.room.id).toBe(roomId)
    expect(found?.equipmentLines).toEqual([
      { equipmentId, name: EQUIPMENT_NAME, requestedQuantity: 2 },
    ])

    // And it is in the grid, addressed by that id, because the screen re-read the
    // list after the write rather than splicing the row in locally. The search
    // scopes the claim to this run (see the file header: page 1 of an unscoped
    // list eventually fills up with older runs' leftovers).
    const user = userEvent.setup()
    await user.type(await screen.findByTestId('table-search'), TOKEN)
    await waitForRequest('Bookings', (variables) => (variables['filter'] as { search?: string }).search === TOKEN)
    await waitFor(() =>
      expect(dataRows().map((row) => row.getAttribute('data-id'))).toContain(id),
    )
    expect(dataRowTexts().join(' ')).toContain(uiBookingPurpose)

    view.unmount()
  }, 180_000)

  it('2. a refused create renders the server’s own reason, and the client rules mirror it', async () => {
    const view = await openBookingsAsOwner()
    await openCreateDialog()
    const user = userEvent.setup()

    // The same room, the same hour as the booking test 1 just created. Nothing
    // about this form is invalid as far as the client can tell, so the refusal
    // has to come from the server: the room is taken.
    const overlap = `${TOKEN}overlap`
    await fillBookingForm({ purpose: overlap })
    const before = await gql<{ bookings: { totalCount: number } }>(
      `query { bookings(page: 1, pageSize: 50) { totalCount } }`,
      {},
      adminToken,
    )
    await user.click(screen.getByTestId('form-submit'))

    // The server's own words for a taken room — not "something went wrong" — in
    // the place a form-level message belongs.
    const banner = await screen.findByTestId('form-error')
    expect(banner).toHaveTextContent('The selected room is not available for the requested time range')
    expect(banner).toBeVisible()

    // The dialog stayed open with the typed values, and nothing claims success.
    expect(screen.getByTestId('form')).toBeInTheDocument()
    expect(screen.getByLabelText(/^purpose/i)).toHaveValue(overlap)
    expect(screen.queryByTestId('booking-created')).not.toBeInTheDocument()

    // …and it came off the wire with the server's own code, not a guess.
    const refusal = recorded
      .filter((entry) => entry.operationName === 'CreateBooking' && entry.extensions !== null)
      .at(-1)
    expect(refusal?.message).toBe('The selected room is not available for the requested time range')
    expect(refusal?.extensions?.['code']).toBe('CONFLICT')
    // A `CONFLICT` is not a field error: the message is not also repeated under
    // an input, which is what `formLevelError` decides.
    expect(refusal?.extensions?.['fieldErrors']).toBeUndefined()

    // No booking was created: the count is unchanged.
    const after = await gql<{ bookings: { totalCount: number } }>(
      `query { bookings(page: 1, pageSize: 50) { totalCount } }`,
      {},
      adminToken,
    )
    expect(after.bookings.totalCount).toBe(before.bookings.totalCount)

    // The client-side rules are the same rules, and they are the *only* thing
    // stopping these two: an end at or before its start…
    const sends = (): number => recorded.filter((entry) => entry.operationName === 'CreateBooking').length
    const sentSoFar = sends()

    await setDateTime(/^start/i, SLOT_A.startInput)
    await setDateTime(/^end/i, SLOT_A.startInput)
    await user.click(screen.getByTestId('form-submit'))
    expect(await screen.findByTestId('field-error-endTime')).toHaveTextContent('End must be after start')
    expect(sends()).toBe(sentSoFar)

    // …a start in the past…
    const past = slot(-2, 9)
    await setDateTime(/^start/i, past.startInput)
    await setDateTime(/^end/i, past.endInput)
    await user.click(screen.getByTestId('form-submit'))
    expect(await screen.findByTestId('field-error-startTime')).toHaveTextContent('Start must not be in the past')
    expect(sends()).toBe(sentSoFar)

    // …and fewer than one attendee, which is the server's own `@Min(1)` rule
    // (the input carries `min=1` too, so the browser would refuse it as well).
    await setDateTime(/^start/i, SLOT_A.startInput)
    await setDateTime(/^end/i, SLOT_A.endInput)
    const attendees = screen.getByLabelText(/number of attendees/i)
    await user.clear(attendees)
    await user.type(attendees, '0')
    await user.click(screen.getByTestId('form-submit'))
    expect(await screen.findByTestId('field-error-numberOfAttendees')).toHaveTextContent(
      'Number of attendees must be at least 1',
    )
    expect(sends()).toBe(sentSoFar)

    // A required field, and a half-filled equipment row, are refused the same
    // way — the group row in particular is a form concern, not a server one.
    await user.clear(screen.getByLabelText(/^purpose/i))
    await user.click(screen.getByTestId('form-submit'))
    expect(await screen.findByTestId('field-error-purpose')).toHaveTextContent('Purpose is required')

    await user.type(screen.getByLabelText(/^purpose/i), overlap)
    await user.click(screen.getByTestId('group-add-equipment'))
    await screen.findByTestId('group-row-equipment-0')
    await user.type(
      within(screen.getByTestId('group-row-equipment-0')).getByLabelText(/quantity/i),
      '1',
    )
    await user.click(screen.getByTestId('form-submit'))
    expect(await screen.findByTestId('field-error-equipment.0.equipmentId')).toHaveTextContent(
      'Item is required',
    )
    expect(sends()).toBe(sentSoFar)

    // Filling the row in and removing it both work, and a removed row takes its
    // own values with it (the row after it is renumbered, not left with a
    // stranger's quantity).
    await selectOption(/^item/i, new RegExp(EQUIPMENT_NAME))
    await user.click(screen.getByTestId('group-remove-equipment-0'))
    await waitFor(() => expect(screen.queryByTestId('group-row-equipment-0')).not.toBeInTheDocument())
    // With no rows left, the form is valid again and the create is attempted —
    // and the server is what refuses it, the same way it did the first time.
    await user.click(screen.getByTestId('form-submit'))
    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      'The selected room is not available for the requested time range',
    )

    // Closing the dialog, the grid never grew a row: a refused create is not a
    // row. (The grid is only readable here — an open modal marks the page behind
    // it `aria-hidden`, which is correct behaviour, not a test problem.)
    await user.click(screen.getByTestId('form-cancel'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    await user.type(screen.getByTestId('table-search'), TOKEN)
    await waitFor(() => expect(dataRowTexts().join(' ')).toContain(uiBookingPurpose))
    expect(dataRowTexts().join(' ')).not.toContain(overlap)

    view.unmount()
  }, 180_000)

  it('3. the list and the create form are the shared DataTable and Form', async () => {
    // (a) Static: the booking screen imports both shared components by the very
    // same specifier C1's four screens use…
    const page = readFileSync(
      path.join(CLIENT_ROOT, 'src', 'features', 'bookings', 'pages', 'BookingsPage.tsx'),
      'utf8',
    )
    expect(page).toContain("from '@/components/DataTable'")
    expect(page).toContain("from '@/components/Form'")
    // …and nothing outside the shared component touches the grid. (The theme is
    // the other sanctioned place: it sets the grid's palette.)
    const gridImporters: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry)) continue
        if (full.includes(`${path.sep}__tests__${path.sep}`)) continue
        if (!readFileSync(full, 'utf8').includes('@mui/x-data-grid')) continue
        if (full.startsWith(path.join(CLIENT_ROOT, 'src', 'components', 'DataTable'))) continue
        if (full.startsWith(path.join(CLIENT_ROOT, 'src', 'theme'))) continue
        gridImporters.push(path.relative(CLIENT_ROOT, full))
      }
    }
    walk(path.join(CLIENT_ROOT, 'src'))
    expect(gridImporters).toEqual([])

    // (b) Runtime: the mounted screen renders those two components, and the grid
    // is the one inside the shared wrapper. The session is the owner employee's
    // rather than the admin's because the admin no longer holds `booking:create`,
    // so the create dialog it opens is one the server will accept.
    const view = await openBookingsAsOwner()
    const table = await screen.findByTestId('datatable')
    expect(table).toHaveAttribute('data-component', 'DataTable')
    expect(table.querySelector('.MuiDataGrid-root')).not.toBeNull()
    await waitFor(() => expect(dataRowTexts().length).toBeGreaterThan(0))

    // The create dialog is the *same* Form, now driving a repeatable group and a
    // datetime input — no booking-specific copy of the component.
    await openCreateDialog()
    const form = await screen.findByTestId('form')
    expect(form).toHaveAttribute('data-component', 'Form')
    expect(form.tagName).toBe('FORM')
    expect(form.querySelector('[data-testid="group-equipment"]')).not.toBeNull()
    expect(form.querySelector('input[type="datetime-local"]')).not.toBeNull()
    // The group starts empty: equipment is optional, and an empty list is not a
    // list of blank rows waiting to fail validation.
    expect(form.querySelector('[data-testid="group-row-equipment-0"]')).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('group-add-equipment'))
    const row = await screen.findByTestId('group-row-equipment-0')
    expect(within(row).getByLabelText(/item/i)).toBeInTheDocument()
    expect(within(row).getByLabelText(/quantity/i)).toBeInTheDocument()
    await user.click(screen.getByTestId('group-remove-equipment-0'))
    await waitFor(() => expect(screen.queryByTestId('group-row-equipment-0')).not.toBeInTheDocument())
    await user.click(screen.getByTestId('form-cancel'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())

    // A row click is the screen's decision, and the table only reports it: the
    // route it lands on carries the booking's own id. The search scopes the row
    // being clicked to this run.
    await user.type(screen.getByTestId('table-search'), TOKEN)
    await waitFor(() =>
      expect(dataRows().map((row) => row.getAttribute('data-id'))).toContain(uiBookingId),
    )
    const target = dataRows().find((row) => row.getAttribute('data-id') === uiBookingId)
    expect(target).toBeDefined()
    await user.click(target as HTMLElement)
    // The detail screen itself is C2's second half now, so the click has to land
    // on the *real* view rather than the placeholder this used to assert: the
    // claim is still that the row's own id is what the route carries.
    const detail = await screen.findByTestId('booking-detail')
    expect(detail).toHaveAttribute('data-booking-id', uiBookingId)
    expect(screen.getByTestId('booking-detail-id')).toHaveTextContent(uiBookingId)
    // The booking created in test 1 is the one being opened, and the server is the
    // one that resolved it: the status chip is the API's answer, not a local guess.
    expect(screen.getByTestId('booking-detail-status')).toHaveTextContent('PENDING')
    // The detail read is the server's answer about the booking this screen
    // created in test 1 — same purpose, so the two views cannot disagree.
    expect(screen.getByTestId('requested-purpose')).toHaveTextContent(uiBookingPurpose)

    view.unmount()
  }, 180_000)

  it('4. a booking:read:own session sees its own bookings and nothing else', async () => {
    // One booking the session legitimately owns, created through the API with
    // its own token, so the proof is about a real requester's own row.
    const ownerToken = (
      await gql<{ login: string }>(
        `mutation Login($input: LoginInput!) { login(input: $input) }`,
        { input: { email: ownerEmail, password: PASSWORD } },
      )
    ).login
    const ownPurpose = `${TOKEN}mine`
    const ownId = await createBooking(ownerToken, {
      roomId,
      startTime: SLOT_D.start.toISOString(),
      endTime: SLOT_D.end.toISOString(),
      purpose: ownPurpose,
      numberOfAttendees: 3,
    })

    const view = renderApp(newClient(), '/login')
    await signInAndWait(ownerEmail, PASSWORD)
    const permissions = JSON.parse(probe().dataset.permissions ?? '[]') as string[]
    expect(permissions).toContain('booking:read:own')
    expect(permissions).toContain('booking:create')
    expect(permissions).not.toContain('booking:read:all')
    const user = userEvent.setup()
    await user.click(within(await screen.findByTestId('nav-bookings')).getByRole('link'))
    await screen.findByTestId('datatable')
    await waitFor(() => expect(dataRowTexts().length).toBeGreaterThan(0))

    const ids = (): (string | null)[] => dataRows().map((row) => row.getAttribute('data-id'))
    // Its own booking is listed, by id and by purpose.
    await waitFor(() => expect(ids()).toContain(ownId))
    expect(dataRowTexts().join(' ')).toContain(ownPurpose)

    // Somebody else's booking is not — and the reason is the server's scoping,
    // not a client-side filter. Asked with this same token, the API itself never
    // returns it: not unfiltered, and not even when it is searched for by name.
    expect(ids()).not.toContain(otherBookingId)
    expect(dataRowTexts().join(' ')).not.toContain(otherBookingPurpose)
    const searched = await gql<{ bookings: { totalCount: number } }>(
      LIST_BOOKINGS,
      { filter: { search: otherBookingPurpose } },
      ownerToken,
    )
    expect(searched.bookings.totalCount).toBe(0)

    // What the client rendered is exactly what the server returned, id for id.
    // A client-side filter could only ever *hide* rows, so an equality like this
    // in both directions is what "the server scoped it" actually means.
    const serverPage = await gql<{ bookings: { items: { id: string }[] } }>(LIST_BOOKINGS, {}, ownerToken)
    const serverIds = serverPage.bookings.items.map((item) => item.id)
    expect(ids().length).toBe(serverIds.length)
    for (const id of ids()) {
      expect(serverIds).toContain(id)
    }

    // The requester's own name is the server's own label (one loader for the
    // whole page, NFR-1), and the create control is offered because the same
    // seeded role holds `booking:create` — the read scope is what is narrow, not
    // the whole screen.
    expect(dataRowTexts().join(' ')).toContain('Ola Owner')
    expect(screen.getByTestId('new-booking')).toBeInTheDocument()

    view.unmount()
  }, 180_000)

  it('5. search and every filter reach the server as GraphQL variables (FR-41/42)', async () => {
    // `from` skips the requests earlier tests left in the log, so "the first
    // read" means the first read of *this* render.
    const mark = recorded.length
    const view = await openBookingsAsAdmin()

    // The first read: page 1 of 20, no filter and no sort, i.e. the server's own
    // default order.
    const first = await waitForRequest('Bookings', (variables) => variables['page'] === 1, mark)
    expect(first.variables).toEqual({ page: 1, pageSize: 20 })
    await waitFor(() => expect(dataRowTexts().length).toBeGreaterThan(0))
    // The count is the server's `totalCount`, not the length of the page, and it
    // covers every booking in the database — this run's four plus whatever the
    // shared dev database already held. (So the row count is deliberately *not*
    // asserted to equal it here; the scoped assertion further down is where the
    // two must agree.)
    expect(Number(screen.getByTestId('table-total').textContent?.split(' ')[0])).toBeGreaterThanOrEqual(4)

    const user = userEvent.setup()
    /**
     * Types a search term and waits for the request that carries it.
     *
     * Clearing the box first is not asserted with a request, and the reason is
     * worth writing down: a query whose variables are *equal* to one the server
     * already answered is served from the Apollo cache, so clearing a filter back
     * to the initial state issues no request at all. (Measured, not assumed — an
     * earlier version of this test waited for one and timed out on a request that
     * was never going to happen.) Every "the filter is gone again" claim below is
     * therefore made on the *next* request, or on the rows that came back.
     */
    const search = async (text: string): Promise<void> => {
      await user.clear(screen.getByTestId('table-search'))
      // The clear only reaches the table's state once the debounce settles, and
      // nothing observable comes out of it (see `settleTable`). Without this, the
      // *next* control is read against a state that still holds the old search —
      // which is how an earlier version of this test sent `{ search, status }` and
      // called it a failure of the status filter.
      await settleTable()
      if (text === '') {
        return
      }
      await user.type(screen.getByTestId('table-search'), text)
      await waitForRequest(
        'Bookings',
        (variables) => (variables['filter'] as { search?: string } | undefined)?.search === text,
        mark,
      )
    }

    // Search by purpose — a column the page can see.
    await search(`${TOKEN}with-equipment`)
    await waitFor(() => expect(dataRowTexts()).toHaveLength(1))
    expect(dataRows()[0]?.getAttribute('data-id')).toBe(equipmentBookingId)

    // Search by equipment name, which is *not* a column value: FR-41's EXISTS
    // over `booking_equipment` is the only way this can match, so a client-side
    // filter could not produce it.
    await search(EQUIPMENT_NAME)
    await waitFor(() => expect(dataRowTexts().join(' ')).toContain(`${TOKEN}with-equipment`))

    // Search by room name: every one of this run's bookings is in that room, and
    // nothing from a previous run's room is.
    await search(ROOM_NAME)
    await waitFor(() => expect(dataRowTexts()).toHaveLength(4))
    const byRoom = dataRowTexts().join(' ')
    expect(byRoom).toContain(`${TOKEN}with-equipment`)
    expect(byRoom).toContain(otherBookingPurpose)
    expect(byRoom).toContain(uiBookingPurpose)
    expect(byRoom).toContain(`${TOKEN}mine`)

    // A search that matches nothing comes back empty from the server, and the
    // grid says so rather than showing a stale page.
    await search(`${TOKEN}no-such-booking`)
    await waitFor(() => expect(dataRowTexts()).toHaveLength(0))
    expect(screen.getByText('No bookings match this search')).toBeInTheDocument()

    // The status filter: a select over the enum's own values, applied on change.
    // The search is cleared first, and the request that follows is the proof: its
    // `filter` carries `status` and *nothing else*, so the cleared search is
    // genuinely not being sent alongside it.
    await search('')
    await user.click(await screen.findByLabelText(/^status$/i))
    await user.click(await screen.findByRole('option', { name: 'PENDING' }))
    const byStatus = await waitForRequest(
      'Bookings',
      (variables) => (variables['filter'] as { status?: string } | undefined)?.status === 'PENDING',
      mark,
    )
    expect(byStatus.variables['filter']).toEqual({ status: 'PENDING' })
    expect(byStatus.variables['page']).toBe(1)
    // Every fixture is PENDING, and the count is the server's.
    await waitFor(() => expect(dataRowTexts().length).toBeGreaterThan(0))
    expect(Number(screen.getByTestId('table-total').textContent?.split(' ')[0])).toBeGreaterThanOrEqual(4)

    // The enum's own empty choice clears it. No request follows, for the same
    // reason clearing the search did not: `{ page, pageSize }` with no filter is
    // the first query this client ever made, and Apollo answers it from the cache.
    // The rows coming back is the visible half of that, and the request after the
    // next change is the half that proves the `status` key is really gone.
    await user.click(screen.getByLabelText(/^status$/i))
    await user.click(await screen.findByRole('option', { name: 'All' }))
    await waitFor(() => expect(Number(screen.getByTestId('table-total').textContent?.split(' ')[0])).toBeGreaterThanOrEqual(4))
    expect(lastRequest('Bookings')?.variables['filter']).toEqual({ status: 'PENDING' })

    // The date range: two `date` inputs, expanded to instants by the screen (the
    // table knows only `startDate`/`endDate`; the ISO edges are this endpoint's
    // shape). Both are asserted as the exact instants the day means.
    //
    // The search stays set to this run's token while the dates are applied, so the
    // scope is exactly this run's four bookings and the row count can be an
    // equality: a bare date range would also catch bookings a previous run left
    // behind on the same calendar days (there is no `deleteBooking`), which would
    // make the count prove nothing about the filter.
    await search(TOKEN)
    const day = dayOf(SLOT_B.start)
    await setDateTime(/^from$/i, day)
    const from = await waitForRequest(
      'Bookings',
      (variables) => typeof (variables['filter'] as { startDate?: string } | undefined)?.startDate === 'string',
      mark,
    )
    expect((from.variables['filter'] as { startDate?: string }).startDate).toBe(
      new Date(new Date(`${day}T00:00:00`).getTime()).toISOString(),
    )
    await setDateTime(/^to$/i, day)
    const to = await waitForRequest(
      'Bookings',
      (variables) => typeof (variables['filter'] as { endDate?: string } | undefined)?.endDate === 'string',
      mark,
    )
    expect((to.variables['filter'] as { endDate?: string }).endDate).toBe(
      new Date(new Date(`${day}T23:59:59.999`).getTime()).toISOString(),
    )
    // The server filtered: the two bookings that start on that day are in, the
    // two from three days earlier are out, and the count agrees with the rows.
    const dated = await waitForRequest(
      'Bookings',
      (variables) =>
        typeof (variables['filter'] as { startDate?: string } | undefined)?.startDate === 'string' &&
        typeof (variables['filter'] as { endDate?: string } | undefined)?.endDate === 'string',
      mark,
    )
    const datedFilter = dated.variables['filter'] as {
      search?: string
      status?: string
      startDate?: string
      endDate?: string
    }
    expect(datedFilter.search).toBe(TOKEN)
    // The cleared status really is gone from the request, not merely unrendered.
    expect(datedFilter.status).toBeUndefined()
    await waitFor(() => expect(dataRowTexts()).toHaveLength(2))
    expect(dataRowTexts().join(' ')).toContain(`${TOKEN}with-equipment`)
    expect(dataRowTexts().join(' ')).toContain(otherBookingPurpose)
    expect(dataRowTexts().join(' ')).not.toContain(uiBookingPurpose)
    expect(dataRowTexts().join(' ')).not.toContain(`${TOKEN}mine`)
    expect(dataRowTexts().length).toBe(Number(screen.getByTestId('table-total').textContent?.split(' ')[0]))

    // "Clear filters" is the filter bar's own control, and it clears the *bar*:
    // the search box is a separate control with its own state, so the search has to
    // be emptied separately. Both halves are visible — the date inputs empty and
    // the rows come back…
    await user.click(screen.getByTestId('clear-filters'))
    await waitFor(() => expect(screen.getByTestId('filter-startDate')).toHaveValue(''))
    await search('')
    await waitFor(() => expect(Number(screen.getByTestId('table-total').textContent?.split(' ')[0])).toBeGreaterThanOrEqual(4))
    // …and the *next* request carries no filter at all, which is where that claim
    // is made (see `search`: the cleared query itself is a cache hit).
    await user.click(screen.getByRole('columnheader', { name: /^start/i }))
    const sorted = await waitForRequest(
      'Bookings',
      (variables) => (variables['sort'] as { direction?: string } | undefined)?.direction === 'ASC',
      mark,
    )
    expect(sorted.variables).toEqual({ page: 1, pageSize: 20, sort: { field: 'startTime', direction: 'ASC' } })

    view.unmount()
  }, 180_000)
})
