import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createServer } from 'node:net'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ApolloClient } from '@apollo/client'
import { render, screen, waitFor, within, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Button from '@mui/material/Button'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import { AppProviders } from '@/AppProviders'
import { AppRoutes } from '@/AppRoutes'
import { createApolloClient } from '@/apollo/client'
import { tokenStorage } from '@/apollo/token-storage'
import { useAuth } from '@/auth/AuthProvider'
import { CORPORATE_BLUE, theme } from '@/theme'

/**
 * C0 acceptance suite. It renders the real app — the same providers, router and
 * guards `main.tsx` mounts — in jsdom against a real GraphQL server that this
 * file boots on an ephemeral port (apps/server/src/main.ts, real Postgres, real
 * JWTs). Nothing about auth, permissions or the theme is stubbed.
 */

// vitest runs with the workspace root as cwd (`apps/client`); jsdom's
// import.meta.url is an http URL, so paths are derived from cwd rather than
// from import.meta.
const CLIENT_ROOT = process.cwd()
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..', '..')
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps', 'server', 'src', 'main.ts')
const SERVER_TSCONFIG = path.join(REPO_ROOT, 'apps', 'server', 'tsconfig.json')

let server: ChildProcessByStdio<null, Readable, Readable>
let graphqlUrl: string
let adminToken: string
let fixtureEmail: string
let fixtureId: string
const serverLog: string[] = []

function envValue(key: string): string {
  const text = readFileSync(path.join(REPO_ROOT, '.env'), 'utf8')
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match !== null && match[1] === key) {
      return (match[2] ?? '').trim()
    }
  }
  throw new Error(`${key} is not set in .env`)
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('could not read a free port')))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

interface GraphQLResponse<T> {
  data?: T
  errors?: { message: string }[]
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}, token?: string): Promise<T> {
  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ query, variables }),
  })
  const payload = (await response.json()) as GraphQLResponse<T>
  if (payload.errors !== undefined && payload.errors.length > 0) {
    throw new Error(`GraphQL: ${payload.errors.map((e) => e.message).join('; ')}`)
  }
  if (payload.data === undefined) {
    throw new Error('GraphQL: no data')
  }
  return payload.data
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'never attempted'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
      lastError = `status ${String(response.status)}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `server did not become healthy within ${String(timeoutMs)}ms (${lastError})\n${serverLog.join('')}`,
  )
}

beforeAll(async () => {
  const port = await freePort()
  graphqlUrl = `http://127.0.0.1:${String(port)}/graphql`

  server = spawn(TSX_BIN, ['--tsconfig', SERVER_TSCONFIG, SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()))
  server.stderr.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()))

  await waitForHealth(`http://127.0.0.1:${String(port)}/health`, 90_000)

  // Sign in as the seeded bootstrap admin to create the fixture used by the
  // route-guard proof: an account whose role grants no report access.
  const admin = await gql<{ login: string }>(
    `mutation Login($input: LoginInput!) { login(input: $input) }`,
    { input: { email: envValue('ADMIN_EMAIL'), password: envValue('ADMIN_PASSWORD') } },
  )
  adminToken = admin.login

  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  fixtureEmail = `c0-fixture-${suffix}@resource.local`
  const created = await gql<{ createEmployee: { id: string } }>(
    `mutation Create($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`,
    {
      input: {
        firstName: 'Casey',
        lastName: 'Fixture',
        email: fixtureEmail,
        password: 'Fixture@12345',
      },
    },
    adminToken,
  )
  fixtureId = created.createEmployee.id

  const roles = await gql<{ roles: { items: { id: string; roleName: string }[] } }>(
    `query { roles { items { id roleName } } }`,
    {},
    adminToken,
  )
  const employeeRole = roles.roles.items.find((role) => role.roleName === 'Employee')
  if (employeeRole === undefined) {
    throw new Error('seeded Employee role is missing')
  }
  await gql<{ assignRoleToEmployee: { id: string } }>(
    `mutation Assign($input: EmployeeRoleInput!) { assignRoleToEmployee(input: $input) { id } }`,
    { input: { employeeId: fixtureId, roleId: employeeRole.id } },
    adminToken,
  )
}, 120_000)

afterAll(async () => {
  if (fixtureId !== undefined && adminToken !== undefined) {
    await gql(`mutation Delete($id: String!) { deleteEmployee(id: $id) }`, { id: fixtureId }, adminToken).catch(
      () => undefined,
    )
  }
  if (server !== undefined) {
    const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()))
    server.kill('SIGTERM')
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
    if (server.exitCode === null) {
      server.kill('SIGKILL')
    }
  }
}, 60_000)

function newClient(): ApolloClient {
  return createApolloClient({ uri: graphqlUrl })
}

/** Renders the app exactly as `main.tsx` does, plus a probe of the live session. */
function renderApp(client: ApolloClient, route: string): RenderResult {
  function AuthProbe(): React.ReactNode {
    const { status, session, permissions } = useAuth()
    return (
      <div
        data-testid="auth-probe"
        data-status={status}
        data-permissions={JSON.stringify([...permissions].sort())}
        data-roles={JSON.stringify(session?.roles.map((role) => role.roleName) ?? [])}
        data-email={session?.employee.email ?? ''}
      />
    )
  }
  return render(
    <AppProviders client={client} initialEntries={[route]}>
      <AuthProbe />
      <AppRoutes />
    </AppProviders>,
  )
}

function probe(): HTMLElement {
  return screen.getByTestId('auth-probe')
}

async function signIn(email: string, password: string): Promise<void> {
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText(/email/i), email)
  await user.type(await screen.findByLabelText(/password/i), password)
  await user.click(screen.getByTestId('login-submit'))
}

describe('C0 — client foundation', () => {
  it('1. codegen output is present, typed, and no GraphQL is hand-written', async () => {
    const generated = path.join(CLIENT_ROOT, 'src', 'graphql')
    const files = readdirSync(generated).filter((name) => statSync(path.join(generated, name)).isFile())
    expect(files.sort()).toEqual(['gql.ts', 'graphql.ts', 'index.ts'])

    const typed = readFileSync(path.join(generated, 'graphql.ts'), 'utf8')
    // The operation result and variable types are generated, not annotated.
    expect(typed).toMatch(/export type MeQuery = \{/)
    expect(typed).toMatch(/permissionKeys: Array<string>/)
    expect(typed).toMatch(/export type LoginMutation = \{ login: string \}/)
    // The document itself is a TypedDocumentNode, which is what makes
    // `useQuery(MeDocument)` fully typed against Apollo Client 4.
    expect(typed).toMatch(/export const MeDocument = \{[\s\S]*?\} as unknown as DocumentNode</)
    expect(readFileSync(path.join(generated, 'gql.ts'), 'utf8')).toMatch(
      /mutation Login\(\$input: LoginInput!\)/,
    )

    // No GraphQL operation may be written by hand anywhere outside the
    // generated directory: documents live in features/**/graphql and are
    // registered by their exact string in the generated map.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) {
          if (full !== path.join(CLIENT_ROOT, 'src', 'graphql')) {
            walk(full)
          }
          continue
        }
        if (!/\.tsx?$/.test(entry)) continue
        // The documents themselves live in features/<area>/graphql/ and are
        // registered in the generated map by their exact text; anywhere else a
        // hand-written operation would be an untyped one.
        if (/features[\\/][^\\/]+[\\/]graphql[\\/]/.test(full)) continue
        if (full.includes(`${path.sep}__tests__${path.sep}`)) continue
        const text = stripComments(readFileSync(full, 'utf8'))
        if (/`\s*(query|mutation)\s+\w+/m.test(text)) {
          offenders.push(path.relative(CLIENT_ROOT, full))
        }
      }
    }
    walk(path.join(CLIENT_ROOT, 'src'))
    expect(offenders).toEqual([])
  })

  it('2. a valid login stores the JWT and `me` populates the permission set', async () => {
    const view = renderApp(newClient(), '/login')
    await signIn(envValue('ADMIN_EMAIL'), envValue('ADMIN_PASSWORD'))

    await waitFor(() => expect(probe().dataset.status).toBe('authenticated'))

    const token = tokenStorage.get()
    expect(token).not.toBeNull()
    expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)

    // The session is the `me` query's result, not anything the login mutation
    // returned (it returns a bare token).
    expect(probe().dataset.email).toBe(envValue('ADMIN_EMAIL'))
    expect(probe().dataset.roles).toBe('["Admin"]')
    expect(JSON.parse(probe().dataset.permissions ?? '[]')).toEqual([
      'audit:read',
      'booking:approve',
      'booking:cancel:any',
      'booking:cancel:own',
      'booking:create',
      'booking:read:all',
      'booking:read:own',
      'booking:reject',
      'employee:read',
      'employee:write',
      'equipment:read',
      'equipment:write',
      'permission:read',
      'report:read',
      'role:assign',
      'role:read',
      'role:write',
      'room:read',
      'room:write',
    ])

    // The UI is driven by that set: the admin sees every nav item. Eight since
    // C1 added the Roles screen; the assertion is deliberately a count, not a
    // list, so a nav item cannot be added without this number moving.
    const nav = screen.getByTestId('nav')
    expect(within(nav).getAllByRole('listitem')).toHaveLength(8)
    expect(screen.getByTestId('current-user-email')).toHaveTextContent(envValue('ADMIN_EMAIL'))
    expect(screen.getByTestId('role-Admin')).toBeInTheDocument()
    view.unmount()
  })

  it('3. invalid credentials fail visibly and store no JWT', async () => {
    const view = renderApp(newClient(), '/login')
    await signIn(envValue('ADMIN_EMAIL'), 'definitely-not-the-password')

    const alert = await screen.findByTestId('login-error')
    expect(alert).toBeVisible()
    expect(alert).toHaveTextContent('Sign-in failed. Check your email and password.')
    expect(probe().dataset.status).toBe('anonymous')
    expect(tokenStorage.get()).toBeNull()
    expect(window.localStorage.length).toBe(0)
    expect(screen.queryByTestId('nav')).not.toBeInTheDocument()
    view.unmount()
  })

  it('4. nav and routes are driven by the permission set', async () => {
    renderApp(newClient(), '/login')
    await signIn(fixtureEmail, 'Fixture@12345')
    await waitFor(() => expect(probe().dataset.status).toBe('authenticated'))

    // The fixture holds only the Employee role: booking:create/read:own/
    // cancel:own, room:read, equipment:read. No report:read, no employee:read.
    expect(probe().dataset.roles).toBe('["Employee"]')
    expect(JSON.parse(probe().dataset.permissions ?? '[]')).not.toContain('report:read')
    expect(screen.queryByTestId('nav-reports')).not.toBeInTheDocument()
    expect(screen.queryByTestId('nav-employees')).not.toBeInTheDocument()
    expect(screen.getByTestId('nav-bookings')).toBeInTheDocument()
    expect(screen.getByTestId('nav-rooms')).toBeInTheDocument()

    // A route this user does hold opens normally, by clicking the nav item.
    const user = userEvent.setup()
    await user.click(within(screen.getByTestId('nav-bookings')).getByRole('link'))
    expect(await screen.findByTestId('placeholder-bookings')).toBeInTheDocument()
    expect(screen.queryByTestId('guard-denied-alert')).not.toBeInTheDocument()
  })

  it('5. a deep link to a route the user lacks a permission for is refused', async () => {
    // Straight at /reports, no navigation, no nav item to click.
    renderApp(newClient(), '/reports')
    await signIn(fixtureEmail, 'Fixture@12345')

    const denial = await screen.findByTestId('guard-denied-alert')
    expect(denial).toBeVisible()
    expect(denial).toHaveTextContent('Not authorised')
    expect(screen.queryByTestId('placeholder-reports')).not.toBeInTheDocument()
    expect(screen.queryByText('Reports')).not.toBeInTheDocument()
    // The refusal is a rendered page, not a redirect loop back to login.
    expect(screen.queryByTestId('login-submit')).not.toBeInTheDocument()
    expect(probe().dataset.status).toBe('authenticated')
  })

  it('5. the MUI theme is applied — corporate blue, light mode, ThemeProvider at the root', async () => {
    renderApp(newClient(), '/login')
    const submit = await screen.findByTestId('login-submit')

    // The button is a real MUI slot component, styled through emotion.
    expect(submit).toHaveClass('MuiButton-contained', 'MuiButton-colorPrimary')
    const generatedClasses = submit.className.split(/\s+/).filter((name) => name.startsWith('css-'))
    expect(generatedClasses.length).toBeGreaterThan(0)

    const css = collectEmotionCss()
    const buttonRule = ruleFor(css, generatedClasses[0] ?? '')
    console.log(`\n  themed submit button class: ${generatedClasses.join(' ')}`)
    console.log(`  rule for that class: ${buttonRule ?? '(not found)'}`)
    console.log(
      `  --variant-containedBg declaration: ${declarationFor(css, '--variant-containedBg')}`,
    )

    // The button's background comes from the theme, through the CSS variable
    // MUI's own contained-variant rule reads.
    expect(buttonRule).toMatch(/background-color:var\(--variant-containedBg\)/)
    expect(declarationFor(css, '--variant-containedBg')).toBe(CORPORATE_BLUE)
    expect(declarationFor(css, '--variant-containedColor')).toBe('#ffffff')
    // The theme's component overrides are live too: no ALL-CAPS buttons.
    expect(buttonRule).toMatch(/text-transform:none/)
    expect(buttonRule).toMatch(/font-weight:600/)
    // And the colour is ours, not MUI's stock primary, which appears nowhere.
    expect(css).toContain(CORPORATE_BLUE)
    expect(css.toLowerCase()).not.toContain('#1976d2')
    expect(css.replace(/\s/g, '')).not.toContain('rgb(25,118,210)')

    expect(theme.palette.mode).toBe('light')
    expect(theme.palette.primary.main).toBe(CORPORATE_BLUE)

    // And the app's own overrides are live, not just declared: once signed in,
    // the shell's AppBar is the theme's corporate blue too. Same render — the
    // token is in storage now, so the app lands on a screen rather than /login.
    await signIn(envValue('ADMIN_EMAIL'), envValue('ADMIN_PASSWORD'))
    await waitFor(() => expect(probe().dataset.status).toBe('authenticated'))
    const appBar = await screen.findByRole('banner')
    expect(appBar).toHaveClass('MuiAppBar-root')
    expect(collectEmotionCss()).toContain(CORPORATE_BLUE)

    // The decisive check: the colour comes from the ThemeProvider that wraps
    // the app (src/AppProviders.tsx), not from a hard-coded value. An identical
    // button under a *different* theme in the same document comes out
    // different, and ours keeps the corporate blue.
    const other = render(
      <ThemeProvider theme={createTheme({ palette: { mode: 'light', primary: { main: '#b71c1c' } } })}>
        <Button variant="contained" data-testid="alt-submit">
          other theme
        </Button>
      </ThemeProvider>,
    )
    const altClass = other.getByTestId('alt-submit').className.split(/\s+/).find((c) => c.startsWith('css-')) ?? ''
    const altRule = ruleFor(collectEmotionCss(), altClass) ?? ''
    expect(altRule).toContain('#b71c1c')
    expect(altRule).not.toContain(CORPORATE_BLUE)
    expect(buttonRule).toContain(CORPORATE_BLUE)
    other.unmount()
  })

  it('6. the Apollo client has no WebSocket link', async () => {
    const apolloSource = stripComments(
      readFileSync(path.join(CLIENT_ROOT, 'src', 'apollo', 'client.ts'), 'utf8'),
    )
    expect(apolloSource).toMatch(/new HttpLink\(/)
    expect(apolloSource).toMatch(/authLink\.concat\(httpLink\)/)
    expect(apolloSource).not.toMatch(/split\(|GraphQLWsLink|graphql-ws|WebSocket|ws:\/\//)

    // Nothing anywhere in the client may reintroduce one.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) {
          if (full !== path.join(CLIENT_ROOT, 'node_modules')) {
            walk(full)
          }
          continue
        }
        if (!/\.tsx?$/.test(entry)) continue
        if (full.includes(`${path.sep}__tests__${path.sep}`)) continue
        const text = stripComments(readFileSync(full, 'utf8'))
        if (/graphql-ws|GraphQLWsLink|createClient\(|ws:\/\/|new WebSocket/.test(text)) {
          offenders.push(path.relative(CLIENT_ROOT, full))
        }
      }
    }
    walk(path.join(CLIENT_ROOT, 'src'))
    expect(offenders).toEqual([])
  })
})

/** Comments are prose, not code: strip them before scanning source for patterns. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** All CSS emotion has injected, from both the style tags and the CSSOM. */
function collectEmotionCss(): string {
  const parts: string[] = []
  for (const style of Array.from(document.querySelectorAll('style'))) {
    parts.push(style.textContent ?? '')
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        parts.push(rule.cssText)
      }
    } catch {
      // A sheet jsdom will not hand over (cross-origin) is not our problem.
    }
  }
  return parts.join('\n')
}

function ruleFor(css: string, className: string): string | null {
  if (className === '') return null
  const index = css.indexOf(`.${className}{`)
  if (index === -1) return null
  const end = css.indexOf('}', index)
  return css.slice(index, end === -1 ? undefined : end + 1)
}

function declarationFor(css: string, variable: string): string {
  const match = new RegExp(`${variable}:\\s*([^;}]+)`).exec(css)
  return match?.[1]?.trim() ?? ''
}
