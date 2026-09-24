import 'reflect-metadata'
import type { AddressInfo } from 'node:net'
import { GraphQLError } from 'graphql'
import type { DataSource } from 'typeorm'
import { loadEnv } from '../src/config/env'
import { createDataSource } from '../src/config/data-source'
import { createApp } from '../src/app'
import { InputValidationError } from '../src/common/errors/field-errors'
import { formatError } from '../src/common/errors/format-error'
import { SYSTEM_EMPLOYEE_EMAIL } from '../src/modules/employee/system-account'

const INVALID_EMAIL = 'definitely-not-an-email'
const SECRET_PASSWORD = 'S3cret-Password-#42'

interface FieldError {
  field: string
  message: string
}

interface GqlError {
  message: string
  extensions?: { code?: string; fieldErrors?: FieldError[] }
}

interface GqlResponse {
  status: number
  data?: Record<string, unknown> | null
  errors?: GqlError[]
}

let port = 0
let failures = 0

function log(line: string): void {
  console.log(line)
}

function check(name: string, condition: boolean, evidence: string): void {
  if (condition) {
    log(`  [PASS] ${name}`)
    if (evidence !== '') log(`         ${evidence}`)
  } else {
    failures += 1
    log(`  [FAIL] ${name} — ${evidence}`)
  }
}

async function gql(query: string): Promise<GqlResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = (await response.json()) as Omit<GqlResponse, 'status'>
  return { status: response.status, ...body }
}

function firstError(response: GqlResponse): GqlError | null {
  return response.errors?.[0] ?? null
}

function test1InputValidationErrorFormatsAsFieldErrors(): void {
  log('TEST 1 — service-thrown InputValidationError formats through the same extension shape')
  const thrown = new InputValidationError([{ field: 'email', message: 'email already in use' }])
  const wrapped = new GraphQLError('Validation failed', { originalError: thrown })
  const formatted = formatError({ message: wrapped.message }, wrapped)
  const extensions = (formatted.extensions ?? {}) as { code?: string; fieldErrors?: FieldError[] }
  check(
    'InputValidationError → code BAD_USER_INPUT + extensions.fieldErrors',
    extensions.code === 'BAD_USER_INPUT' &&
      JSON.stringify(extensions.fieldErrors) === JSON.stringify([{ field: 'email', message: 'email already in use' }]),
    `extensions=${JSON.stringify(extensions)}`,
  )
}

async function test2InvalidLoginReturnsFieldErrors(): Promise<void> {
  log('TEST 2 — invalid login input returns field-level errors, not a 500 or an unstructured string')
  const response = await gql(`mutation { login(input: { email: "${INVALID_EMAIL}", password: "" }) }`)
  const error = firstError(response)
  check(
    'HTTP 200 with a structured GraphQL error and null data',
    response.status === 200 && error !== null && response.data === null,
    `http=${String(response.status)}, data=${JSON.stringify(response.data)}`,
  )
  const fieldErrors = error?.extensions?.fieldErrors ?? []
  check(
    "field error reported for 'email' (IsEmail) and 'password' (IsNotEmpty)",
    fieldErrors.some((e) => e.field === 'email' && e.message.length > 0) &&
      fieldErrors.some((e) => e.field === 'password' && e.message.length > 0),
    `fieldErrors=${JSON.stringify(fieldErrors)}`,
  )
  check(
    'error code is BAD_USER_INPUT via the existing extensions convention',
    error?.extensions?.code === 'BAD_USER_INPUT',
    `message="${String(error?.message)}", extensions=${JSON.stringify(error?.extensions)}`,
  )
  log(`         actual response error: ${JSON.stringify(error)}`)
}

async function test3OnlyOffendingFieldAndNoValueEcho(): Promise<void> {
  log('TEST 3 — only the offending field is reported, and no submitted values are echoed back')
  const response = await gql(`mutation { login(input: { email: "${INVALID_EMAIL}", password: "${SECRET_PASSWORD}" }) }`)
  const fieldErrors = firstError(response)?.extensions?.fieldErrors ?? []
  const serialized = JSON.stringify(response)
  check(
    "valid password is not reported — only the 'email' field error is present",
    fieldErrors.length === 1 && fieldErrors[0]?.field === 'email',
    `fieldErrors=${JSON.stringify(fieldErrors)}`,
  )
  check(
    'raw class-validator payload (validationErrors / value) never reaches the client',
    !serialized.includes('validationErrors') && !serialized.includes('"value"'),
    `keys present in response: ${serialized.slice(0, 120)}…`,
  )
  check(
    'submitted email and password values are not echoed in the response',
    !serialized.includes(SECRET_PASSWORD) && !serialized.includes(INVALID_EMAIL),
    `secret present=${String(serialized.includes(SECRET_PASSWORD))}, invalid email present=${String(serialized.includes(INVALID_EMAIL))}`,
  )
}

async function test4S2ErrorShapesUnchanged(): Promise<void> {
  log('TEST 4 — the S2 error conventions compose unchanged (no second convention introduced)')
  const forbidden = await gql('mutation { createRole(input: { roleName: "should never exist" }) { id } }')
  const forbiddenError = firstError(forbidden)
  check(
    "authorisation failure keeps its S2 shape: 'Not authorised' | FORBIDDEN | no fieldErrors",
    forbiddenError?.message === 'Not authorised' &&
      forbiddenError?.extensions?.code === 'FORBIDDEN' &&
      forbiddenError?.extensions?.fieldErrors === undefined,
    `→ ${JSON.stringify(forbiddenError)}`,
  )

  const systemLogin = await gql(`mutation { login(input: { email: "${SYSTEM_EMPLOYEE_EMAIL}", password: "any-password" }) }`)
  const systemLoginError = firstError(systemLogin)
  check(
    "valid input passes validation and reaches the service: 'Invalid email or password' | UNAUTHENTICATED",
    systemLoginError?.message === 'Invalid email or password' &&
      systemLoginError?.extensions?.code === 'UNAUTHENTICATED' &&
      systemLoginError?.extensions?.fieldErrors === undefined,
    `→ ${JSON.stringify(systemLoginError)}`,
  )
}

async function main(): Promise<void> {
  const env = loadEnv()
  const dataSource = createDataSource()
  await dataSource.initialize()
  const app = await createApp(dataSource)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  port = (server.address() as AddressInfo).port
  log(`field-error formatter test — server pid ${process.pid}, port ${port}, db ${env.db.name}`)
  log('')

  try {
    test1InputValidationErrorFormatsAsFieldErrors()
    log('')
    await test2InvalidLoginReturnsFieldErrors()
    log('')
    await test3OnlyOffendingFieldAndNoValueEcho()
    log('')
    await test4S2ErrorShapesUnchanged()
  } finally {
    server.close()
    await dataSource.destroy()
  }

  log('')
  if (failures === 0) {
    log('RESULT: all field-error formatter checks passed')
    process.exit(0)
  }
  log(`RESULT: ${failures} check(s) FAILED`)
  process.exit(1)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`field-error formatter test crashed: ${message}`)
  process.exit(1)
})
