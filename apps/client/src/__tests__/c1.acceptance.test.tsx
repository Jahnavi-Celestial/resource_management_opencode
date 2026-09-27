import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminToken,
  bootServer,
  CLIENT_ROOT,
  dataRowTexts,
  envValue,
  gql,
  gqlRaw,
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
    { name: 'C1 Filter Big', location: 'North', capacity: 12 },
    { name: 'C1 Filter Small', location: 'South', capacity: 3 },
    { name: 'C1 Filter Retired', location: 'North', capacity: 8 },
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
      expect(texts.some((text) => text.includes('C1 Filter Big'))).toBe(true)
      expect(texts.some((text) => text.includes('C1 Filter Small'))).toBe(false)
    })
    // And the retired room is excluded by activeOnly, not by luck.
    expect(dataRowTexts().some((text) => text.includes('C1 Filter Retired'))).toBe(false)

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
})
