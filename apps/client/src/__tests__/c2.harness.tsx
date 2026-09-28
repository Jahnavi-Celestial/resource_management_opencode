import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'
import type { ApolloClient } from '@apollo/client'
import { fireEvent, render, screen, waitFor, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect } from 'vitest'
import { AppProviders } from '@/AppProviders'
import { AppRoutes } from '@/AppRoutes'
import { createApolloClient } from '@/apollo/client'
import { useAuth } from '@/auth/AuthProvider'

/**
 * The C2 acceptance harness: a real `apps/server/src/main.ts` on an ephemeral
 * port, the real app mounted through the real providers, and a `fetch` stub that
 * records exactly what went over the wire.
 *
 * It is C1's harness, kept as a separate file for the reason C0's is: the three
 * suites are independent, so a change to C1's fixtures cannot quietly alter C2's
 * verdicts (or the other way round). C2's addition is the pair of helpers at the
 * bottom for the two controls a booking form has that the C1 screens did not:
 * a `datetime-local` input and a repeatable group row.
 *
 * Nothing is mocked: the recording forwards to the real `fetch`, so every
 * assertion is about a request that really reached a really-booted API.
 */

export const CLIENT_ROOT = process.cwd()
export const REPO_ROOT = path.resolve(CLIENT_ROOT, '..', '..')
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps', 'server', 'src', 'main.ts')
const SERVER_TSCONFIG = path.join(REPO_ROOT, 'apps', 'server', 'tsconfig.json')

/**
 * Exactly two classes of unhandled rejection are tolerated, and neither is the
 * app's — the same two C1 pinned down, for the same reasons:
 *
 * 1. `AbortError: The operation was aborted` — an in-flight `ObservableQuery`
 *    losing its last subscriber, which these screens do on purpose (a debounced
 *    search superseding its own predecessor, a test unmounting mid-load).
 * 2. `CombinedGraphQLErrors` — a *refused* mutation. The refusal is genuinely
 *    handled: the booking create form stays open and shows the server's message
 *    (test 2), and the promise the screen awaits is caught.
 *
 * Both are Apollo Client 4 throwing from its *own* subscription, where an
 * application handler cannot reach them (their stacks are `QueryManager.js` plus
 * rxjs plumbing, with no frame from `src/`). The point of listing them is that it
 * is the *only* list: anything else lands in `unexpectedRejections()`, and the
 * suite asserts that list is empty. The allowlist was checked for being
 * non-vacuous — an injected rejection fails the suite.
 */
function isApolloInternalRethrow(reason: unknown): boolean {
  // Duck-typed on `name`/`message` rather than `instanceof Error`, because the same
  // teardown arrives in two shapes: Apollo's own `AbortError`, and the `DOMException`
  // jsdom's `AbortController` rejects with — which is *not* an `Error` subclass there,
  // so the `instanceof` half of this check missed it and the C1 suite failed roughly
  // one run in three on a teardown it is meant to tolerate. Nothing about the event
  // differs; only the constructor does, and the requirement stays the same one: an
  // abort, carrying abort's message, and nothing else.
  if (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as { name?: unknown }).name === 'AbortError' &&
    typeof (reason as { message?: unknown }).message === 'string'
  ) {
    return /operation was aborted/i.test((reason as { message: string }).message)
  }
  if (typeof reason !== 'object' || reason === null) {
    return false
  }
  const constructorName = (reason as { constructor?: { name?: string } }).constructor?.name
  if (constructorName !== 'CombinedGraphQLErrors') {
    return false
  }
  return (reason as { stack?: string }).stack?.includes('QueryManager.js') ?? false
}

const unexpected: unknown[] = []

export function unexpectedRejections(): readonly unknown[] {
  return unexpected
}

process.on('unhandledRejection', (reason) => {
  if (!isApolloInternalRethrow(reason)) {
    unexpected.push(reason)
  }
})

export interface RecordedRequest {
  operationName: string
  variables: Record<string, unknown>
  /** `errors[0].extensions` from the real response, when there was one. */
  extensions: Record<string, unknown> | null
  message: string | null
}

export const recorded: RecordedRequest[] = []

let server: ChildProcessByStdio<null, Readable, Readable> | undefined
let graphqlUrl = ''
export let adminToken = ''
const serverLog: string[] = []
const realFetch = globalThis.fetch.bind(globalThis)

export function envValue(key: string): string {
  const text = readFileSync(path.join(REPO_ROOT, '.env'), 'utf8')
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match !== null && match[1] === key) {
      // dotenv strips one layer of matching quotes and the server reads its config
      // through dotenv, so a raw read has to strip them too — otherwise a quoted
      // `DB_PASSWORD` authenticates as the password *including* the quote marks,
      // which fails against the server the same file just booted successfully.
      const raw = (match[2] ?? '').replace(/\r$/, '').trim()
      const quoted = /^(['"])([\s\S]*)\1$/.exec(raw)
      return quoted === null ? raw : (quoted[2] ?? '')
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
  errors?: { message: string; extensions?: Record<string, unknown> }[]
}

export async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  token?: string,
): Promise<T> {
  const payload = await gqlRaw<T>(query, variables, token)
  if (payload.errors !== undefined && payload.errors.length > 0) {
    throw new Error(`GraphQL: ${payload.errors.map((e) => e.message).join('; ')}`)
  }
  if (payload.data === undefined) {
    throw new Error('GraphQL: no data')
  }
  return payload.data
}

/** Like `gql`, but returns the errors instead of throwing. */
export async function gqlRaw<T>(
  query: string,
  variables: Record<string, unknown> = {},
  token?: string,
): Promise<GraphQLResponse<T>> {
  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ query, variables }),
  })
  return (await response.json()) as GraphQLResponse<T>
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

/** Records every GraphQL request/response, then forwards it untouched. */
function installRecordingFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await realFetch(input, init)
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as { operationName?: string; variables?: Record<string, unknown> })
        : null
    if (body?.operationName !== undefined) {
      const clone = response.clone()
      const parsed = (await clone.json().catch(() => null)) as GraphQLResponse<unknown> | null
      const first = parsed?.errors?.[0]
      recorded.push({
        operationName: body.operationName,
        variables: body.variables ?? {},
        extensions: first?.extensions ?? null,
        message: first?.message ?? null,
      })
    }
    return response
  }) as typeof fetch
}

export async function bootServer(): Promise<void> {
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
  installRecordingFetch()

  const admin = await gql<{ login: string }>(
    `mutation Login($input: LoginInput!) { login(input: $input) }`,
    { input: { email: envValue('ADMIN_EMAIL'), password: envValue('ADMIN_PASSWORD') } },
  )
  adminToken = admin.login
}

export async function stopServer(): Promise<void> {
  globalThis.fetch = realFetch
  if (server === undefined) {
    return
  }
  const exited = new Promise<void>((resolve) => server?.once('exit', () => resolve()))
  server.kill('SIGTERM')
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
  if (server.exitCode === null) {
    server.kill('SIGKILL')
  }
}

export function newClient(): ApolloClient {
  return createApolloClient({ uri: graphqlUrl })
}

/**
 * Deletes the `email_outbox` rows addressed to these addresses, and returns how
 * many went.
 *
 * The outbox is *addressed*, not linked: `email_outbox` has no employee foreign
 * key, so deleting the employee leaves its decision mail behind, and the dev
 * server's cron will dutifully try to send it. No GraphQL mutation can reach
 * those rows, so a suite that approves or rejects anything has to clear its own
 * by address — and it has to do it *before* the employees go, because the address
 * is the only handle there is.
 *
 * This is deliberately one fixed statement against one fixed table, not a hook
 * into the server's own DataSource: the suite is testing the app over HTTP, and
 * the single thing it is allowed to touch behind the API's back is the debris
 * the API will not let it remove.
 */
export async function clearOutboxFor(toEmails: readonly string[]): Promise<number> {
  if (toEmails.length === 0) {
    return 0
  }
  const client = new Client({
    host: envValue('DB_HOST'),
    port: Number(envValue('DB_PORT')),
    user: envValue('DB_USERNAME'),
    password: envValue('DB_PASSWORD'),
    database: envValue('DB_NAME'),
  })
  await client.connect()
  try {
    const result = await client.query('DELETE FROM email_outbox WHERE to_email = ANY($1::text[])', [
      [...toEmails],
    ])
    return result.rowCount ?? 0
  } finally {
    await client.end()
  }
}

/** The app, mounted exactly as `main.tsx` mounts it, plus a session probe. */
export function renderApp(client: ApolloClient, route: string): RenderResult {
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

export function probe(): HTMLElement {
  return screen.getByTestId('auth-probe')
}

export async function signIn(email: string, password: string): Promise<void> {
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText(/email/i), email)
  await user.type(await screen.findByLabelText(/password/i), password)
  await user.click(screen.getByTestId('login-submit'))
}

export async function signInAndWait(email: string, password: string): Promise<void> {
  await signIn(email, password)
  await waitFor(() => expect(probe().dataset.status).toBe('authenticated'))
}

/** The last recorded request for an operation, optionally after a mark. */
export function lastRequest(operationName: string, from = 0): RecordedRequest | undefined {
  return recorded
    .slice(from)
    .reverse()
    .find((entry) => entry.operationName === operationName)
}

/**
 * Waits until the operation's *latest* request matches `predicate`.
 *
 * Latest, not any: a screen's table asks the server several times in a row (a
 * debounced search, a filter that resets a draft), and "some request at some
 * point had no search" is true long before the user has finished clearing the
 * box. What a test means by "the request says X" is the one the screen is
 * waiting on now.
 *
 * `from` skips the requests already in the log, which is how a test that mounts
 * the screen itself can talk about "the first read of *this* render" rather than
 * about whatever the previous test left behind.
 */
export async function waitForRequest(
  operationName: string,
  predicate: (variables: Record<string, unknown>) => boolean,
  from = 0,
): Promise<RecordedRequest> {
  let match: RecordedRequest | undefined
  await waitFor(
    () => {
      match = lastRequest(operationName, from)
      expect(match, `no ${operationName} request was recorded`).toBeDefined()
      // A bare `toBe(true)` on the predicate hides the one thing that matters
      // when this fails: the variables that actually went out.
      expect(
        predicate(match?.variables ?? {}),
        `${operationName} last sent ${JSON.stringify(match?.variables)}`,
      ).toBe(true)
    },
    { timeout: 8000 },
  )
  return match as RecordedRequest
}

/**
 * The grid's data rows, in render order. `getAllByRole('row')` includes the
 * header row, hence the slice.
 */
export function dataRowTexts(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.textContent ?? '')
}

/**
 * The data rows as elements, for reading a row's `data-id` (which is the
 * booking's UUID, and the only way to assert *which* booking is on screen
 * without matching on a formatted date).
 */
export function dataRows(): HTMLElement[] {
  return screen.getAllByRole('row').slice(1)
}

/**
 * Sets a `datetime-local` or `date` input, found by its *label* rather than by
 * the field's testid: a `FormField`'s testid sits on the `TextField` root, so it
 * is a `<div>` and a `change` on it would go nowhere.
 *
 * `fireEvent.change` rather than `userEvent.type` on purpose: both inputs are
 * segmented native controls, and typing "2026-03-04T09:00" into one means
 * driving jsdom's internal field state through keystrokes, which tests the
 * browser's widget rather than the screen. The React `onChange` that fires here
 * is the same one a real pick fires.
 */
export async function setDateTime(label: RegExp, value: string): Promise<void> {
  const input = await screen.findByLabelText(label)
  fireEvent.change(input, { target: { value } })
}

/**
 * Waits out the table's search debounce (`searchDebounceMs`, 300 ms by default in
 * `DataTable`) so a change has certainly reached the screen.
 *
 * This is a sleep, and deliberately so. The alternative — waiting for the request
 * a cleared filter produces — does not exist: those variables were already
 * answered by the server, so Apollo answers them from its cache and no request
 * goes out. Nor can the rendered rows be the signal, because on a first run the
 * unfiltered page and this run's token-scoped page are the same four rows. Waiting
 * on a request that cannot happen, or on a coincidence, would be a worse test.
 */
export async function settleTable(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500))
}

/** Picks an option from a MUI select, matched by the option's visible text. */
export async function selectOption(label: RegExp, optionText: RegExp): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByLabelText(label))
  await user.click(await screen.findByRole('option', { name: optionText }))
}

/**
 * The page size these suites ask the grid for: the largest it offers.
 *
 * `100` is the server's `MAX_PAGE_SIZE` and the grid's own top option, so a walk
 * over a global set needs as few page transitions as possible.
 */
export const PAGE_SIZE = 100

/** The grid's page-size control, as the user sees it. */
export function pageSizeValue(): string {
  return document.querySelector('.MuiTablePagination-select')?.textContent ?? ''
}

/**
 * The page the grid is showing, read from the footer's own "1–100 of 144" label.
 *
 * The request that fetched a page is not the observable here — it is not always
 * one, because a page this session has already fetched is answered from Apollo's
 * cache — and the *button* is not either, because it is stale at the end of the
 * set and a click on it changes nothing while still looking enabled. The
 * footer's range is the rendered page, so it cannot be either of those.
 */
export function displayedPage(): number {
  const label = document.querySelector('.MuiTablePagination-displayedRows')?.textContent ?? ''
  const match = /(\d+)\D+(\d+)\D+of\D+(\d+)/.exec(label)
  if (match === null) {
    throw new Error(`cannot read the grid's page from "${label}"`)
  }
  return Math.ceil(Number(match[1]) / PAGE_SIZE)
}

/**
 * Waits for the grid to finish a load, and says so if the query was refused.
 *
 * An empty grid and a *refused* grid look identical from the outside — a refused
 * query nulls the whole thing, fields and all — so the refusal's own text rides
 * along in the failure message.
 */
export async function settleGrid(): Promise<void> {
  await waitFor(() => {
    expect(
      screen.queryByTestId('table-loading'),
      `the table query was refused: ${screen.queryByTestId('screen-error')?.textContent ?? 'no error shown'}`,
    ).not.toBeInTheDocument()
  })
}

/** The grid row whose `data-id` is this booking's, on the current page, or null. */
export function rowOnThisPage(bookingId: string): HTMLElement | null {
  return (
    screen
      .getAllByRole('row')
      .slice(1)
      .find((candidate) => candidate.dataset['id'] === bookingId) ?? null
  )
}

/**
 * Puts one specific booking on screen, and returns its row.
 *
 * This cannot be page 1 by arithmetic. Both server-paginated sets these suites
 * walk are global and unsearchable (`pendingQueue` takes no `search` at all), and
 * this database has grown with every client run — so this run's fixtures are
 * wherever their creation time puts them, usually on the last page. Hence the
 * walk: take the largest page the grid offers, then step through the pages
 * checking each one, and stop when the grid stops moving. The DataGrid's footer
 * has no "Go to last page" — only previous/next — so "the end of the set" is a
 * thing this walks to rather than one it clicks.
 *
 * A row has to be matched on its `data-id`, never on the booking's UUID in its
 * accessible name: the UUID is not in a row's name, so `getByRole('row', {name:
 * /uuid/})` is `null` whether the row is there or not.
 */
export async function showRow(bookingId: string): Promise<HTMLElement> {
  await selectOption(/rows per page/i, new RegExp(`^${String(PAGE_SIZE)}$`))
  await waitFor(() => {
    expect(pageSizeValue()).toBe(String(PAGE_SIZE))
  })
  await settleGrid()

  for (let step = 0; step < 40; step += 1) {
    const row = rowOnThisPage(bookingId)
    if (row !== null) {
      return row
    }
    const page = displayedPage()
    const next = screen.getByRole('button', { name: 'Go to next page' }) as HTMLButtonElement
    if (next.disabled === true) {
      break
    }
    await userEvent.setup().click(next)
    // Last page: the click is a no-op and the walk is done. A refusal would also
    // stop the walk, which `settleGrid` reports by name.
    const moved = await waitFor(() => {
      expect(displayedPage()).toBe(page + 1)
    }, { timeout: 2000 }).then(
      () => true,
      () => false,
    )
    if (!moved) {
      break
    }
    await settleGrid()
  }
  throw new Error(`booking ${bookingId} is on no page`)
}

/**
 * Ends the session the app is currently holding, through the shell's own button.
 *
 * The token is persisted in `localStorage` exactly as in a browser, so a second
 * render in the same file would otherwise start out as the *previous* identity —
 * which quietly turns a claim about "a session without permission X" into a claim
 * about whoever was signed in before.
 */
export async function signOutIfSignedIn(): Promise<void> {
  await waitFor(() => {
    expect(['anonymous', 'authenticated']).toContain(probe().dataset.status)
  })
  if (probe().dataset.status !== 'authenticated') {
    return
  }
  await userEvent.setup().click(screen.getByTestId('sign-out'))
  await screen.findByTestId('login-submit')
}
