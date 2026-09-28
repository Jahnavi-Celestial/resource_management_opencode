import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ApolloClient } from '@apollo/client'
import { render, screen, waitFor, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect } from 'vitest'
import { AppProviders } from '@/AppProviders'
import { AppRoutes } from '@/AppRoutes'
import { createApolloClient } from '@/apollo/client'
import { useAuth } from '@/auth/AuthProvider'

/**
 * The C1 acceptance harness: a real `apps/server/src/main.ts` on an ephemeral
 * port, the real app mounted through the real providers, and a `fetch` stub that
 * records exactly what went over the wire.
 *
 * The recording is the point: proving that the shared `DataTable` drives the
 * *server* (NFR-7) means asserting on the variables of a request that really
 * reached a really-booted API, not on a mock's call arguments. The stub forwards
 * every call to the real `fetch`, so nothing is faked — including the C0 suite's
 * shape of `renderApp`, which the four screens are mounted through.
 *
 * C0 keeps its own inline copy of this setup; the two suites are independent on
 * purpose, so a change to C1's fixtures cannot quietly alter C0's verdicts.
 */

export const CLIENT_ROOT = process.cwd()
export const REPO_ROOT = path.resolve(CLIENT_ROOT, '..', '..')
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps', 'server', 'src', 'main.ts')
const SERVER_TSCONFIG = path.join(REPO_ROOT, 'apps', 'server', 'tsconfig.json')

/**
 * Exactly two classes of unhandled rejection are tolerated, and neither is the
 * app's. Both are Apollo Client 4 rethrowing from its *own* subscription, where
 * an application handler cannot reach them — the stack of each is
 * `QueryManager.js` plus rxjs plumbing, with no frame from `src/`.
 *
 * 1. `AbortError: The operation was aborted` — an in-flight `ObservableQuery`
 *    losing its last subscriber, which every screen here does on purpose: a
 *    debounced search that supersedes its own predecessor, and a test that
 *    unmounts the app while a page is still loading.
 * 2. `CombinedGraphQLErrors` — a *refused* mutation. The refusal is genuinely
 *    handled (test 3 asserts the duplicate email appears under its own input,
 *    with the dialog still open), and the promise the screen awaits is caught;
 *    declaring `onError` on the hook was measured and changes nothing, because
 *    the throw happens on a subscription the hook does not own.
 *
 * The point of listing them is that it is the *only* list. Anything else — a
 * fire-and-forget promise in a component, a rejected refetch nobody awaits —
 * lands in `unexpectedRejections()`, and the suite asserts that list is empty at
 * the end. So the tolerance is an assertion with a two-item allowlist, not a
 * blanket ignore.
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
  // Only the library's own throw, not a rejection somebody re-threw by hand.
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

/** Like `gql`, but returns the errors instead of throwing (permission proofs). */
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
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { operationName?: string; variables?: Record<string, unknown> }) : null
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

/** The last recorded request for an operation, or undefined. */
export function lastRequest(operationName: string): RecordedRequest | undefined {
  return [...recorded].reverse().find((entry) => entry.operationName === operationName)
}

/** Waits until an operation has been sent with variables matching `predicate`. */
export async function waitForRequest(
  operationName: string,
  predicate: (variables: Record<string, unknown>) => boolean,
): Promise<RecordedRequest> {
  let match: RecordedRequest | undefined
  await waitFor(
    () => {
      match = lastRequest(operationName)
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
