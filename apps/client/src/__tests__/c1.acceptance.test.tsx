import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminToken,
  bootServer,
  CLIENT_ROOT,
  clearOutboxLike,
  dataRowTexts,
  envValue,
  gql,
  gqlRaw,
  lastRequest,
  newClient,
  probe,
  recorded,
  renderApp,
  signIn,
  signInAndWait,
  stopServer,
  unexpectedRejections,
  waitForRequest,
} from './c1.harness'

/**
 * C1 acceptance suite: four CRUD screens built on the *same* `DataTable` and the
 * *same* `Form`, against a real server. Every claim below is made against the
 * app that ships (`AppProviders` → `AppRoutes`) and a real API — the only
 * instrumentation is a `fetch` wrapper that records what was sent and what came
 * back.
 */

const PASSWORD = 'Fixture@12345'
const PREFIX = 'c1-list-'
const ROOM_PREFIX = `c1-${Date.now()}-`

interface Fixture {
  email: string
  lastName: string
  id: string
}

const listFixtures: Fixture[] = []
const roomFixtures: { id: string; name: string }[] = []
/** Anything a test creates and fails to clean up is removed here anyway. */
const createdEmployeeIds: string[] = []
let readonlyEmail = ''
let readonlyPassword = PASSWORD

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

beforeAll(async () => {
  await bootServer()

  // Three employees whose last names make a known sort order, all matched by one
  // search term. The round-trip test sorts by them and reads the rendered order,
  // so the assertion is about the server's ORDER BY, not about a local sort.
  for (const [index, lastName] of ['Zeta', 'Alpha', 'Middle'].entries()) {
    const email = `${PREFIX}${String(index)}@resource.local`
    const created = await gql<{ createEmployee: { id: string } }>(
      CREATE_EMPLOYEE,
      { input: { firstName: 'Cee', lastName, email, password: PASSWORD } },
      adminToken,
    )
    listFixtures.push({ email, lastName, id: created.createEmployee.id })
    createdEmployeeIds.push(created.createEmployee.id)
  }

  // A Manager: `employee:read` but no `employee:write` — the read-only caller
  // the permission proof signs in as.
  readonlyEmail = 'c1-readonly@resource.local'
  const readonly = await gql<{ createEmployee: { id: string } }>(
    CREATE_EMPLOYEE,
    { input: { firstName: 'Robin', lastName: 'Readonly', email: readonlyEmail, password: PASSWORD } },
    adminToken,
  )
  createdEmployeeIds.push(readonly.createEmployee.id)
  const roles = await gql<{ roles: { items: { id: string; roleName: string }[] } }>(
    `query { roles { items { id roleName } } }`,
    {},
    adminToken,
  )
  const manager = roles.roles.items.find((role) => role.roleName === 'Manager')
  if (manager === undefined) {
    throw new Error('seeded Manager role is missing')
  }
  await gql(ASSIGN_ROLE, { input: { employeeId: readonly.createEmployee.id, roleId: manager.id } }, adminToken)

  // Rooms for the server-side filter proof: one big, one small, one retired.
  for (const room of [
    { name: `${ROOM_PREFIX}Big`, location: 'North', capacity: 12 },
    { name: `${ROOM_PREFIX}Small`, location: 'South', capacity: 3 },
    { name: `${ROOM_PREFIX}Retired`, location: 'North', capacity: 8 },
  ]) {
    const created = await gql<{ createRoom: { id: string; name: string } }>(
      CREATE_ROOM,
      { input: room },
      adminToken,
    )
    roomFixtures.push(created.createRoom)
  }
  await gql(
    `mutation Retire($input: UpdateRoomInput!) { updateRoom(input: $input) { id isActive } }`,
    { input: { id: roomFixtures[2]?.id ?? '', isActive: false } },
    adminToken,
  )
  recorded.length = 0
}, 150_000)

afterAll(() => {
  // The harness allowlists one Apollo teardown abort; this is the assertion that
  // makes the allowlist mean something.
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
  // fixture employees. Every fixture email carries the `c1-` prefix, so one
  // statement clears them all before the employees go.
  await clearOutboxLike('c1-%').catch(() => undefined)
  for (const id of createdEmployeeIds) {
    await gql(DELETE_EMPLOYEE, { id }, adminToken).catch(() => undefined)
  }
  for (const id of roomFixtures) {
    await gql(
      `mutation HardClean($input: UpdateRoomInput!) { updateRoom(input: $input) { id } }`,
      { input: { id: id.id, isActive: false } },
      adminToken,
    ).catch(() => undefined)
  }
  await stopServer()
}, 60_000)

/** Opens the create dialog of a screen and fills every field by label. */
async function fillCreateForm(values: Record<string, string>): Promise<void> {
  const user = userEvent.setup()
  for (const [label, value] of Object.entries(values)) {
    await user.type(await screen.findByLabelText(new RegExp(`^${label}`, 'i')), value)
  }
}

async function openCreateDialog(buttonTestId: string): Promise<void> {
  // The button only exists once the screen has rendered, and the screen waits
  // on its first (server) page.
  await screen.findByTestId('datatable')
  const user = userEvent.setup()
  await user.click(await screen.findByTestId(buttonTestId))
  await screen.findByTestId('form')
}

describe('C1 — generic DataTable + Form on four screens', () => {
  it('1. all four screens import the same DataTable and the same Form', async () => {
    // (a) Static proof: one import site, no per-screen reimplementation, and the
    // grid itself is only ever touched by the shared component.
    const featureDirs = ['employees', 'roles', 'rooms', 'equipment']
    const offenders: string[] = []
    for (const feature of featureDirs) {
      const dir = path.join(CLIENT_ROOT, 'src', 'features', feature)
      const files = readdirSync(dir, { recursive: true })
        .map(String)
        .filter((entry) => /\.tsx?$/.test(entry))
      for (const file of files) {
        const text = readFileSync(path.join(dir, file), 'utf8')
        if (text.includes("@/components/DataTable") && text.includes("@/components/Form")) {
          continue
        }
        // A feature file that does not use both is allowed only if it is a
        // document file (no UI) or the page/form component pair itself.
        offenders.push(`features/${feature}/${file}`)
      }
    }
    const pageFiles = offenders.filter((file) => file.endsWith('Page.tsx'))
    expect(pageFiles).toEqual([])

    // Nothing outside the shared component may import the grid.
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
        // The theme is the other sanctioned place: it sets the grid's palette
        // and imports its type augmentation. No screen may touch the grid.
        if (full.startsWith(path.join(CLIENT_ROOT, 'src', 'theme'))) continue
        gridImporters.push(path.relative(CLIENT_ROOT, full))
      }
    }
    walk(path.join(CLIENT_ROOT, 'src'))
    expect(gridImporters).toEqual([])

    // (b) Runtime proof: the mounted screen really renders those two components.
    const view = renderApp(newClient(), '/login')
    await signInAndWait(envValue('ADMIN_EMAIL'), envValue('ADMIN_PASSWORD'))

    const screens: ReadonlyArray<readonly [string, string]> = [
      ['nav-rooms', 'new-room'],
      ['nav-equipment', 'new-equipment'],
      ['nav-roles', 'new-role'],
      ['nav-employees', 'new-employee'],
    ]
    for (const [navTestId, createTestId] of screens) {
      const user = userEvent.setup()
      // The testid is on the <li>; the link is inside it, and a click on the
      // <li> never reaches a child in the DOM.
      await user.click(within(await screen.findByTestId(navTestId)).getByRole('link'))
      const table = await screen.findByTestId('datatable')
      expect(table).toHaveAttribute('data-component', 'DataTable')
      // The wrapper is a Box; the grid is inside it.
      expect(table.querySelector('.MuiDataGrid-root')).not.toBeNull()

      await user.click(screen.getByTestId(createTestId))
      const form = await screen.findByTestId('form')
      expect(form).toHaveAttribute('data-component', 'Form')
      // The one Form, not four: the same element in every screen.
      expect(form.tagName).toBe('FORM')
      await user.click(screen.getByTestId('form-cancel'))
      await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    }
    view.unmount()
  }, 120_000)

  it('2. page/sort/search and filters reach the server as GraphQL variables', async () => {
    const view = renderApp(newClient(), '/login')
    await signInAndWait(envValue('ADMIN_EMAIL'), envValue('ADMIN_PASSWORD'))
    const user = userEvent.setup()
    await user.click(within(await screen.findByTestId('nav-employees')).getByRole('link'))

    // The first render asks the server for page 1 of 20 with no search and no
    // sort, i.e. the server's own default order.
    const first = await waitForRequest('Employees', (variables) => variables['page'] === 1)
    expect(first.variables).toEqual({ page: 1, pageSize: 20 })

    // Search → the `search` argument, after the debounce.
    await user.type(screen.getByTestId('table-search'), PREFIX)
    const searched = await waitForRequest('Employees', (variables) => variables['search'] === PREFIX)
    expect(searched.variables['page']).toBe(1)
    await waitFor(() =>
      expect(dataRowTexts().filter((text) => text.includes('@resource.local'))).toHaveLength(3),
    )

    // Sort: one click is ASC, the next is DESC — and the rendered order follows,
    // which can only be true if the server did the ordering.
    await user.click(screen.getByRole('columnheader', { name: /last name/i }))
    const asc = await waitForRequest(
      'Employees',
      (variables) => (variables['sort'] as { direction?: string } | undefined)?.direction === 'ASC',
    )
    expect(asc.variables['sort']).toEqual({ field: 'lastName', direction: 'ASC' })
    await waitFor(() => expect(dataRowTexts()[0]).toContain('Alpha'))

    await user.click(screen.getByRole('columnheader', { name: /last name/i }))
    await waitForRequest(
      'Employees',
      (variables) => (variables['sort'] as { direction?: string } | undefined)?.direction === 'DESC',
    )
    await waitFor(() => expect(dataRowTexts()[0]).toContain('Zeta'))

    // Pagination → the API's 1-based `page`. The search above matches three
    // employees, which is one page, so clear it first or the button is disabled.
    await user.clear(screen.getByTestId('table-search'))
    await waitForRequest('Employees', (variables) => variables['search'] === undefined)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /go to next page/i })).toBeEnabled(),
    )
    await user.click(screen.getByRole('button', { name: /go to next page/i }))
    const paged = await waitForRequest('Employees', (variables) => variables['page'] === 2)
    expect(paged.variables['page']).toBe(2)
    expect(paged.variables['pageSize']).toBe(20)

    // The same shared DataTable, a different screen: the rooms filter bar
    // addresses real server arguments (minCapacity, activeOnly).
    await user.click(within(screen.getByTestId('nav-rooms')).getByRole('link'))
    await screen.findByTestId('table-filters')
    await user.click(within(screen.getByTestId('table-filters')).getByLabelText(/active only/i))
    const active = await waitForRequest('Rooms', (variables) => variables['activeOnly'] === true)
    expect(active.variables['activeOnly']).toBe(true)

    await user.type(screen.getByTestId('filter-minCapacity'), '4')
    const filtered = await waitForRequest('Rooms', (variables) => variables['minCapacity'] === 4)
    expect(filtered.variables['minCapacity']).toBe(4)
    // The server applied it: the 3-seat room is gone, the 12-seat one is not.
    await waitFor(() => {
      const texts = dataRowTexts()
      expect(texts.some((text) => text.includes(`${ROOM_PREFIX}Big`))).toBe(true)
      expect(texts.some((text) => text.includes(`${ROOM_PREFIX}Small`))).toBe(false)
    })
    // And the retired room is excluded by activeOnly, not by luck.
    expect(dataRowTexts().some((text) => text.includes(`${ROOM_PREFIX}Retired`))).toBe(false)

    view.unmount()
  }, 120_000)

  it('3. a server field error renders inline on the field, not in a banner', async () => {
    const view = renderApp(newClient(), '/login')
    await signInAndWait(envValue('ADMIN_EMAIL'), envValue('ADMIN_PASSWORD'))
    const user0 = userEvent.setup()
    await user0.click(within(await screen.findByTestId('nav-employees')).getByRole('link'))
    await openCreateDialog('new-employee')

    // The seeded admin's email is taken, so this is the server's own duplicate
    // check (S4) answering, not a client-side guess.
    await fillCreateForm({
      'First name': 'Dana',
      'Last name': 'Duplicate',
      Email: envValue('ADMIN_EMAIL'),
      Password: PASSWORD,
    })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('form-submit'))

    // Under the email input, wired to it for assistive tech.
    const inline = await screen.findByTestId('field-error-email')
    expect(inline).toBeVisible()
    expect(inline).toHaveTextContent('Email is already in use')
    expect(screen.getByLabelText(/^email/i)).toHaveAccessibleDescription(/Email is already in use/i)
    // It is the *email field's* error: it lives inside that field's wrapper, and
    // no other field gained one.
    // `data-field` also names the grid's own columns, so scope to the form.
    const form = screen.getByTestId('form')
    const emailField = form.querySelector('[data-field="email"]')
    expect(emailField).not.toBeNull()
    expect(emailField).toContainElement(inline)
    expect(form.querySelectorAll('[data-testid^="field-error-"]')).toHaveLength(1)

    // Not a toast, not a generic banner: the only alert on screen is the field's
    // own helper text, and the dialog stayed open with the other values intact.
    expect(screen.queryByTestId('form-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('form')).toBeInTheDocument()
    expect(screen.getByLabelText(/^first name/i)).toHaveValue('Dana')
    expect(screen.queryAllByRole('alert')).toHaveLength(0)

    // The refusal came from the server as a field error, with the NFR-6 code.
    const refusal = recorded.filter(
      (entry) => entry.operationName === 'CreateEmployee' && entry.extensions !== null,
    ).at(-1)
    expect(refusal?.extensions?.['code']).toBe('BAD_USER_INPUT')
    expect(refusal?.extensions?.['fieldErrors']).toEqual([
      { field: 'email', message: 'Email is already in use' },
    ])

    // Correcting the field clears the error and the employee is created. The
    // address is unique per run: a fixed one would already exist the second time
    // this suite runs against the same dev database, and the retry would be
    // refused for the very reason the test is about.
    const retryEmail = `c1-inline-${Date.now().toString(36)}@resource.local`
    await user.clear(screen.getByLabelText(/^email/i))
    await user.type(screen.getByLabelText(/^email/i), retryEmail)
    await user.click(screen.getByTestId('form-submit'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    expect(screen.getByTestId('screen-notice')).toHaveTextContent('Employee created.')
    const created = await gql<{ employees: { items: { id: string }[] } }>(
      `query One($search: String) { employees(search: $search) { items { id } } }`,
      { search: retryEmail },
      adminToken,
    )
    createdEmployeeIds.push(created.employees.items[0]?.id ?? '')
    view.unmount()
  }, 120_000)

  it('5. without employee:write the controls are absent — and the server refuses', async () => {
    const view = renderApp(newClient(), '/login')
    await signInAndWait(readonlyEmail, readonlyPassword)
    const user = userEvent.setup()
    await user.click(within(await screen.findByTestId('nav-employees')).getByRole('link'))

    // The list itself is allowed: this account holds employee:read.
    const table = await screen.findByTestId('datatable')
    expect(table).toBeInTheDocument()
    await waitFor(() => expect(dataRowTexts().length).toBeGreaterThan(0))

    // …but nothing that writes is on offer.
    expect(screen.queryByTestId('new-employee')).not.toBeInTheDocument()
    expect(screen.queryByTestId('row-edit')).not.toBeInTheDocument()
    expect(screen.queryByTestId('row-delete')).not.toBeInTheDocument()

    // NFR-5: hiding a button is a courtesy. The server refuses the same write
    // when it is attempted directly, with the manager's own token.
    const token = await gql<{ login: string }>(
      `mutation Login($input: LoginInput!) { login(input: $input) }`,
      { input: { email: readonlyEmail, password: readonlyPassword } },
    ).then((result) => result.login)

    const attempt = await gqlRaw<{ createEmployee: unknown }>(
      CREATE_EMPLOYEE,
      { input: { firstName: 'Sneaky', lastName: 'Write', email: 'c1-sneaky@resource.local', password: PASSWORD } },
      token,
    )
    expect(attempt.data?.createEmployee).toBeUndefined()
    expect(attempt.errors?.[0]?.extensions?.['code']).toBe('FORBIDDEN')
    view.unmount()
  }, 120_000)

  it('6. full CRUD on Employee against the real server', async () => {
    const view = renderApp(newClient(), '/login')
    await signInAndWait(envValue('ADMIN_EMAIL'), envValue('ADMIN_PASSWORD'))
    const user = userEvent.setup()
    await user.click(within(await screen.findByTestId('nav-employees')).getByRole('link'))
    await screen.findByTestId('datatable')

    const email = `c1-crud-${Date.now().toString(36)}@resource.local`

    // create
    await openCreateDialog('new-employee')
    await fillCreateForm({
      'First name': 'Casey',
      'Last name': 'Crudbefore',
      Email: email,
      Password: PASSWORD,
    })
    await user.click(screen.getByTestId('form-submit'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    expect(screen.getByTestId('screen-notice')).toHaveTextContent('Employee created.')

    // appears in the list
    await user.clear(screen.getByTestId('table-search'))
    await user.type(screen.getByTestId('table-search'), email)
    await waitForRequest('Employees', (variables) => variables['search'] === email)
    const row = await screen.findByRole('row', { name: new RegExp(email) })
    expect(within(row).getByText('Crudbefore')).toBeInTheDocument()
    const id = row.getAttribute('data-id')
    expect(id).toBeTruthy()
    createdEmployeeIds.push(id ?? '')

    // edit
    await user.click(within(row).getByTestId('row-edit'))
    const dialog = await screen.findByTestId('form')
    expect(within(dialog).getByLabelText(/^email/i)).toHaveValue(email)
    await user.clear(within(dialog).getByLabelText(/^last name/i))
    await user.type(within(dialog).getByLabelText(/^last name/i), 'Crudafter')
    await user.click(screen.getByTestId('form-submit'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    expect(screen.getByTestId('screen-notice')).toHaveTextContent('Employee updated.')

    // the edit is visible in the list, from the server
    await user.clear(screen.getByTestId('table-search'))
    await user.type(screen.getByTestId('table-search'), email)
    await waitFor(() => expect(dataRowTexts().join(' ')).toContain('Crudafter'))

    // delete
    const editedRow = await screen.findByRole('row', { name: new RegExp(email) })
    await user.click(within(editedRow).getByTestId('row-delete'))
    const confirm = await screen.findByTestId('confirm-dialog')
    expect(within(confirm).getByTestId('confirm-message')).toHaveTextContent('Casey Crudafter')
    await user.click(within(confirm).getByTestId('confirm-accept'))
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument())

    // gone from the list, and gone from the server
    await waitFor(() => expect(dataRowTexts().join(' ')).not.toContain(email))
    const lookup = await gqlRaw<{ employee: { id: string } | null }>(
      `query One($id: String!) { employee(id: $id) { id } }`,
      { id: id ?? '' },
      adminToken,
    )
    expect(lookup.errors?.[0]?.extensions?.['code']).toBe('NOT_FOUND')
    createdEmployeeIds.pop()
    view.unmount()
  }, 120_000)

  it('7. the create form offers every role, defaults to Employee, and sends the chosen one', async () => {
    const view = renderApp(newClient(), '/login')
    await signInAndWait(envValue('ADMIN_EMAIL'), envValue('ADMIN_PASSWORD'))
    const user = userEvent.setup()
    await user.click(within(await screen.findByTestId('nav-employees')).getByRole('link'))
    await screen.findByTestId('datatable')

    const email = `c1-role-${Date.now().toString(36)}@resource.local`

    await openCreateDialog('new-employee')

    // The dropdown is there, carries the server's own role names, and opens
    // on the Employee default — the value the form was opened with.
    const roleField = screen.getByLabelText(/^role/i)
    expect(roleField).toHaveTextContent('Employee')
    await user.click(roleField)
    for (const name of ['Admin', 'Manager', 'Employee']) {
      expect(await screen.findByRole('option', { name })).toBeInTheDocument()
    }

    // Picking a different role is what goes on the wire.
    await user.click(screen.getByRole('option', { name: 'Manager' }))
    await fillCreateForm({
      'First name': 'Robin',
      'Last name': 'Rolepick',
      Email: email,
      Password: PASSWORD,
    })
    await user.click(screen.getByTestId('form-submit'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    expect(screen.getByTestId('screen-notice')).toHaveTextContent('Employee created.')

    // The role travelled as the mutation's own variable, not a second call.
    const sent = await waitForRequest('CreateEmployee', (variables) => {
      const input = variables['input'] as { roleId?: string } | undefined
      return typeof input?.roleId === 'string' && input.roleId.length > 0
    })
    const roleId = (sent.variables['input'] as { roleId: string }).roleId
    const roles = await gql<{ roles: { items: { id: string; roleName: string }[] } }>(
      `query { roles { items { id roleName } } }`,
      {},
      adminToken,
    )
    const picked = roles.roles.items.find((role) => role.id === roleId)
    expect(picked?.roleName).toBe('Manager')

    // And the list shows the role the server assigned, for the new row only.
    await user.clear(screen.getByTestId('table-search'))
    await user.type(screen.getByTestId('table-search'), email)
    await waitForRequest('Employees', (variables) => variables['search'] === email)
    const row = await screen.findByRole('row', { name: new RegExp(email) })
    expect(within(row).getByText('Manager')).toBeInTheDocument()
    createdEmployeeIds.push(row.getAttribute('data-id') ?? '')
    view.unmount()
  }, 120_000)

  it('8. the edit form offers a roles multi-select, pre-selected, and saves the difference', async () => {
    const view = renderApp(newClient(), '/login')
    await signInAndWait(envValue('ADMIN_EMAIL'), envValue('ADMIN_PASSWORD'))
    const user = userEvent.setup()
    await user.click(within(await screen.findByTestId('nav-employees')).getByRole('link'))
    await screen.findByTestId('datatable')

    const email = `c1-multirole-${Date.now().toString(36)}@resource.local`

    // A new account still starts on the single create form's default: one role.
    await openCreateDialog('new-employee')
    await fillCreateForm({
      'First name': 'Morgan',
      'Last name': 'Multirole',
      Email: email,
      Password: PASSWORD,
    })
    await user.click(screen.getByTestId('form-submit'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    expect(screen.getByTestId('screen-notice')).toHaveTextContent('Employee created.')

    await user.clear(screen.getByTestId('table-search'))
    await user.type(screen.getByTestId('table-search'), email)
    await waitForRequest('Employees', (variables) => variables['search'] === email)
    const row = await screen.findByRole('row', { name: new RegExp(email) })
    const id = row.getAttribute('data-id')
    expect(id).toBeTruthy()
    createdEmployeeIds.push(id ?? '')
    expect(within(row).getByText('Employee')).toBeInTheDocument()

    // The edit dialog's roles control opens on the role the employee already
    // holds — the server's answer, not a blank box.
    await user.click(within(row).getByTestId('row-edit'))
    const dialog = await screen.findByTestId('form')
    const rolesField = within(dialog).getByLabelText(/^roles/i)
    expect(rolesField).toHaveTextContent('Employee')

    // Adding a second role is a diff, not a replacement: only the new role
    // travels, and the one already held is not re-sent.
    await user.click(rolesField)
    await user.click(await screen.findByRole('option', { name: 'Manager' }))
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('form-submit'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    expect(screen.getByTestId('screen-notice')).toHaveTextContent('Employee updated.')

    const assigns = recorded.filter((entry) => entry.operationName === 'AssignEmployeeRole')
    expect(assigns).toHaveLength(1)
    const input = assigns[0]?.variables['input'] as { employeeId: string; roleId: string } | undefined
    expect(input?.employeeId).toBe(id)
    const roles = await gql<{ roles: { items: { id: string; roleName: string }[] } }>(
      `query { roles { items { id roleName } } }`,
      {},
      adminToken,
    )
    const manager = roles.roles.items.find((role) => role.roleName === 'Manager')
    const employee = roles.roles.items.find((role) => role.roleName === 'Employee')
    expect(input?.roleId).toBe(manager?.id)
    expect(input?.roleId).not.toBe(employee?.id)

    // The list shows both roles, from the server, in the loader's name order.
    await user.clear(screen.getByTestId('table-search'))
    await user.type(screen.getByTestId('table-search'), email)
    await waitForRequest('Employees', (variables) => variables['search'] === email)
    const editedRow = await screen.findByRole('row', { name: new RegExp(email) })
    expect(within(editedRow).getByText('Employee, Manager')).toBeInTheDocument()
    view.unmount()
  }, 120_000)

  it('9. the edit form pre-selects every current role and removes exactly the unchecked one', async () => {
    const view = renderApp(newClient(), '/login')
    await signInAndWait(envValue('ADMIN_EMAIL'), envValue('ADMIN_PASSWORD'))
    const user = userEvent.setup()
    await user.click(within(await screen.findByTestId('nav-employees')).getByRole('link'))
    await screen.findByTestId('datatable')

    const email = `c1-uncheck-${Date.now().toString(36)}@resource.local`

    await openCreateDialog('new-employee')
    await fillCreateForm({
      'First name': 'Uma',
      'Last name': 'Uncheck',
      Email: email,
      Password: PASSWORD,
    })
    await user.click(screen.getByTestId('form-submit'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())

    await user.clear(screen.getByTestId('table-search'))
    await user.type(screen.getByTestId('table-search'), email)
    await waitForRequest('Employees', (variables) => variables['search'] === email)
    const row = await screen.findByRole('row', { name: new RegExp(email) })
    const id = row.getAttribute('data-id')
    expect(id).toBeTruthy()
    createdEmployeeIds.push(id ?? '')

    // A second role given directly, so the edit dialog must pre-select two.
    const roles = await gql<{ roles: { items: { id: string; roleName: string }[] } }>(
      `query { roles { items { id roleName } } }`,
      {},
      adminToken,
    )
    const manager = roles.roles.items.find((role) => role.roleName === 'Manager')
    if (manager === undefined) {
      throw new Error('seeded Manager role is missing')
    }
    await gql(ASSIGN_ROLE, { input: { employeeId: id, roleId: manager.id } }, adminToken)

    // Re-read the row by a *different* term: the assign returned only an id, so
    // Apollo's cached copy of this employee still lists one role, and searching
    // the same email again would be answered from that cache without a request.
    await user.clear(screen.getByTestId('table-search'))
    await user.type(screen.getByTestId('table-search'), 'Uncheck')
    await waitForRequest('Employees', (variables) => variables['search'] === 'Uncheck')
    const freshRow = await screen.findByRole('row', { name: new RegExp(email) })
    expect(within(freshRow).getByText('Employee, Manager')).toBeInTheDocument()

    // The setup assign above is itself a recorded `AssignEmployeeRole`; the
    // assertions below are about what the *dialog* sends, so the log starts here.
    recorded.length = 0

    await user.click(within(freshRow).getByTestId('row-edit'))
    const dialog = await screen.findByTestId('form')
    const rolesField = within(dialog).getByLabelText(/^roles/i)
    expect(rolesField).toHaveTextContent('Employee')
    expect(rolesField).toHaveTextContent('Manager')

    // Unchecking one of two leaves the other selected and sends one remove.
    await user.click(rolesField)
    await user.click(await screen.findByRole('option', { name: 'Employee' }))
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('form-submit'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    expect(screen.getByTestId('screen-notice')).toHaveTextContent('Employee updated.')

    const removes = recorded.filter((entry) => entry.operationName === 'RemoveEmployeeRole')
    expect(removes).toHaveLength(1)
    const removed = removes[0]?.variables['input'] as { employeeId: string; roleId: string } | undefined
    expect(removed?.employeeId).toBe(id)
    const employee = roles.roles.items.find((role) => role.roleName === 'Employee')
    expect(removed?.roleId).toBe(employee?.id)
    // Nothing was re-assigned: the role that stayed checked did not travel.
    expect(recorded.filter((entry) => entry.operationName === 'AssignEmployeeRole')).toHaveLength(0)

    // A fresh term again, for the same reason as above: the edit's `refetch`
    // refreshed the query that was live at submit time (`Uncheck`), so the
    // earlier `email` search would be answered from a stale cache entry.
    await user.clear(screen.getByTestId('table-search'))
    await user.type(screen.getByTestId('table-search'), 'Uma')
    await waitForRequest('Employees', (variables) => variables['search'] === 'Uma')
    const editedRow = await screen.findByRole('row', { name: new RegExp(email) })
    expect(within(editedRow).getByText('Manager')).toBeInTheDocument()
    expect(within(editedRow).queryByText('Employee')).not.toBeInTheDocument()
    view.unmount()
  }, 120_000)

  it('10. a session that can write employees but not assign roles gets no roles control', async () => {
    // A role with employee:read and employee:write but *not* role:assign: the
    // permission split the edit dialog's roles field is gated on. No seeded role
    // has this combination, so the suite makes one and removes it afterwards.
    const createdRole = await gql<{ createRole: { id: string } }>(
      `mutation { createRole(input: { roleName: "Writer" }) { id } }`,
      {},
      adminToken,
    )
    const writerRoleId = createdRole.createRole.id
    const permissions = await gql<{ permissions: { items: { id: string; permissionName: string }[] } }>(
      `query { permissions(page: 1, pageSize: 100) { items { id permissionName } } }`,
      {},
      adminToken,
    )
    const employeeRead = permissions.permissions.items.find((p) => p.permissionName === 'employee:read')
    const employeeWrite = permissions.permissions.items.find((p) => p.permissionName === 'employee:write')
    if (employeeRead === undefined || employeeWrite === undefined) {
      throw new Error('employee:read / employee:write permissions not found')
    }
    await gql(
      `mutation { assignPermissionToRole(input: { roleId: "${writerRoleId}", permissionId: "${employeeRead.id}" }) { id } }`,
      {},
      adminToken,
    )
    await gql(
      `mutation { assignPermissionToRole(input: { roleId: "${writerRoleId}", permissionId: "${employeeWrite.id}" }) { id } }`,
      {},
      adminToken,
    )

    const email = `c1-writer-${Date.now().toString(36)}@resource.local`
    const created = await gql<{ createEmployee: { id: string } }>(
      CREATE_EMPLOYEE,
      { input: { firstName: 'Wren', lastName: 'Writer', email, password: PASSWORD } },
      adminToken,
    )
    const employeeId = created.createEmployee.id
    createdEmployeeIds.push(employeeId)
    await gql(ASSIGN_ROLE, { input: { employeeId, roleId: writerRoleId } }, adminToken)

    const view = renderApp(newClient(), '/login')
    await signInAndWait(email, PASSWORD)
    const user = userEvent.setup()
    await user.click(within(await screen.findByTestId('nav-employees')).getByRole('link'))
    await screen.findByTestId('datatable')

    await user.clear(screen.getByTestId('table-search'))
    await user.type(screen.getByTestId('table-search'), email)
    await waitForRequest('Employees', (variables) => variables['search'] === email)
    const row = await screen.findByRole('row', { name: new RegExp(email) })
    await user.click(within(row).getByTestId('row-edit'))
    const dialog = await screen.findByTestId('form')

    // The session can open and submit this dialog, but the roles control is not
    // on offer: assigning a role is a different permission (NFR-5).
    expect(within(dialog).queryByTestId('field-roles')).not.toBeInTheDocument()
    expect(within(dialog).getByLabelText(/^email/i)).toBeInTheDocument()

    // Hiding the control is a courtesy. The server refuses the same write when
    // it is attempted directly, with this session's own token.
    const token = await gql<{ login: string }>(
      `mutation Login($input: LoginInput!) { login(input: $input) }`,
      { input: { email, password: PASSWORD } },
    ).then((result) => result.login)
    const attempt = await gqlRaw<{ assignRoleToEmployee: unknown }>(
      ASSIGN_ROLE,
      { input: { employeeId, roleId: writerRoleId } },
      token,
    )
    expect(attempt.data?.assignRoleToEmployee).toBeUndefined()
    expect(attempt.errors?.[0]?.extensions?.['code']).toBe('FORBIDDEN')
    view.unmount()

    // The custom role is not a seed: take the assignment back and delete it, so
    // the shared database is left as this suite found it.
    await gql(
      `mutation { removeRoleFromEmployee(input: { employeeId: "${employeeId}", roleId: "${writerRoleId}" }) { id } }`,
      {},
      adminToken,
    )
    await gql(`mutation { deleteRole(id: "${writerRoleId}") }`, {}, adminToken)
  }, 120_000)

  it('11. the roles screen: duplicate name refused, permission picker on create and edit', async () => {
    const view = renderApp(newClient(), '/login')
    await signInAndWait(envValue('ADMIN_EMAIL'), envValue('ADMIN_PASSWORD'))
    const user = userEvent.setup()
    await user.click(within(await screen.findByTestId('nav-roles')).getByRole('link'))
    await screen.findByTestId('datatable')

    // --- duplicate name: the server's own CONFLICT, dialog stays open ---
    await user.click(await screen.findByTestId('new-role'))
    const dialog = await screen.findByTestId('form')
    await user.type(within(dialog).getByLabelText(/^role name/i), 'admin')
    await user.click(screen.getByTestId('form-submit'))
    const error = await within(dialog).findByTestId('form-error')
    expect(error).toHaveTextContent('already exists')
    expect(within(dialog).getByLabelText(/^role name/i)).toHaveValue('admin')

    // --- create with permissions ---
    const roleName = `c1-role-${Date.now().toString(36)}`
    await user.clear(within(dialog).getByLabelText(/^role name/i))
    await user.type(within(dialog).getByLabelText(/^role name/i), roleName)

    const permissionsField = within(dialog).getByLabelText(/^permissions/i)
    await user.click(permissionsField)
    await user.click(await screen.findByRole('option', { name: 'room:read' }))
    await user.click(await screen.findByRole('option', { name: 'equipment:read' }))
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('form-submit'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    expect(screen.getByTestId('screen-notice')).toHaveTextContent('Role created.')

    const createReq = lastRequest('CreateRole')
    expect(createReq).toBeDefined()
    const input = createReq?.variables['input'] as { roleName: string; permissionIds: string[] } | undefined
    expect(input?.roleName).toBe(roleName)
    expect(input?.permissionIds).toHaveLength(2)

    const row = await screen.findByRole('row', { name: new RegExp(roleName) })
    expect(within(row).getByText('2')).toBeInTheDocument()

    // --- edit: pre-selected, add one ---
    await user.click(within(row).getByTestId('row-edit'))
    const editDialog = await screen.findByTestId('form')
    const editPermissions = within(editDialog).getByLabelText(/^permissions/i)
    expect(editPermissions).toHaveTextContent('room:read')
    expect(editPermissions).toHaveTextContent('equipment:read')

    await user.click(editPermissions)
    await user.click(await screen.findByRole('option', { name: 'employee:read' }))
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('form-submit'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    expect(screen.getByTestId('screen-notice')).toHaveTextContent('Role updated.')

    const assignReq = lastRequest('AssignPermissionToRole')
    expect(assignReq).toBeDefined()
    const assignInput = assignReq?.variables['input'] as { roleId: string; permissionId: string } | undefined
    expect(assignInput?.permissionId).toBeDefined()

    const editedRow = await screen.findByRole('row', { name: new RegExp(roleName) })
    expect(within(editedRow).getByText('3')).toBeInTheDocument()
    view.unmount()

    const roles = await gql<{ roles: { items: { id: string; roleName: string }[] } }>(
      `query { roles { items { id roleName } } }`,
      {},
      adminToken,
    )
    const created = roles.roles.items.find((r) => r.roleName === roleName)
    if (created !== undefined) {
      await gql(`mutation { deleteRole(id: "${created.id}") }`, {}, adminToken)
    }
  }, 120_000)

  it('12. the roles screen: system roles are protected from delete and rename', async () => {
    const view = renderApp(newClient(), '/login')
    await signInAndWait(envValue('ADMIN_EMAIL'), envValue('ADMIN_PASSWORD'))
    const user = userEvent.setup()
    await user.click(within(await screen.findByTestId('nav-roles')).getByRole('link'))
    await screen.findByTestId('datatable')

    // The three seeded roles carry Edit but no Delete. The matcher is a
    // standalone-word match, not a substring one: the Admin and Manager rows
    // both grant `employee:read`, so a bare /Employee/i would match them too.
    for (const name of ['Admin', 'Manager', 'Employee']) {
      const row = await screen.findByRole('row', { name: new RegExp(`(^|\\s)${name}(\\s|$)`, 'i') })
      expect(within(row).queryByTestId('row-delete')).not.toBeInTheDocument()
      expect(within(row).getByTestId('row-edit')).toBeInTheDocument()
    }

    // A custom role still offers Delete, so the rule is not over-broad.
    await user.click(await screen.findByTestId('new-role'))
    const dialog = await screen.findByTestId('form')
    const roleName = `c1-protected-${Date.now().toString(36)}`
    await user.type(within(dialog).getByLabelText(/^role name/i), roleName)
    await user.click(screen.getByTestId('form-submit'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    const customRow = await screen.findByRole('row', { name: new RegExp(roleName) })
    expect(within(customRow).getByTestId('row-delete')).toBeInTheDocument()

    // The Admin edit dialog keeps the permissions picker but freezes the name.
    const adminRow = await screen.findByRole('row', { name: /(^|\s)Admin(\s|$)/i })
    await user.click(within(adminRow).getByTestId('row-edit'))
    const editDialog = await screen.findByTestId('form')
    expect(within(editDialog).getByLabelText(/^role name/i)).toBeDisabled()
    await user.click(screen.getByTestId('form-cancel'))
    await waitFor(() => expect(screen.queryByTestId('form')).not.toBeInTheDocument())
    view.unmount()

    // The hidden button is a courtesy, not the control (NFR-5): called directly,
    // the server still refuses with its own SYSTEM_ROLE code.
    const roles = await gql<{ roles: { items: { id: string; roleName: string }[] } }>(
      `query { roles { items { id roleName } } }`,
      {},
      adminToken,
    )
    const admin = roles.roles.items.find((r) => r.roleName === 'Admin')
    expect(admin).toBeDefined()
    const refused = await gqlRaw(`mutation { deleteRole(id: "${admin?.id}") }`, {}, adminToken)
    expect(refused.errors?.[0]?.extensions?.['code']).toBe('SYSTEM_ROLE')

    const custom = roles.roles.items.find((r) => r.roleName === roleName)
    if (custom !== undefined) {
      await gql(`mutation { deleteRole(id: "${custom.id}") }`, {}, adminToken)
    }
  }, 120_000)
})
