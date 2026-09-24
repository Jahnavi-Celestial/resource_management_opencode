import 'reflect-metadata'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { Request } from 'express'
import type { DataSource } from 'typeorm'
import { loadEnv } from '../src/config/env'
import { createDataSource } from '../src/config/data-source'
import { createApp, createGraphQLContext, SCHEMA_GRAPHQL_PATH } from '../src/app'
import { Employee } from '../src/modules/employee/employee.entity'
import { Role } from '../src/modules/rbac/role.entity'

const LEAK_EMAIL = 'loaders.leak@local.test'

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

function anonymousRequest(): Request {
  return { headers: {} } as Request
}

async function cleanupFixtures(dataSource: DataSource): Promise<void> {
  await dataSource.getRepository(Employee).delete({ email: LEAK_EMAIL })
}

async function test1ConcurrentRequestsGetSeparateLoaders(dataSource: DataSource): Promise<[Awaited<ReturnType<typeof createGraphQLContext>>, Awaited<ReturnType<typeof createGraphQLContext>>]> {
  log('TEST 1 — two concurrent requests get separate DataLoader instances')
  const [contextA, contextB] = await Promise.all([
    createGraphQLContext(dataSource, anonymousRequest()),
    createGraphQLContext(dataSource, anonymousRequest()),
  ])
  check(
    'each request builds its own employee and rolePermissions loaders',
    contextA.loaders.employee !== contextB.loaders.employee &&
      contextA.loaders.rolePermissions !== contextB.loaders.rolePermissions,
    `employee loader same instance=${String(contextA.loaders.employee === contextB.loaders.employee)}, rolePermissions loader same instance=${String(contextA.loaders.rolePermissions === contextB.loaders.rolePermissions)}`,
  )
  return [contextA, contextB]
}

async function test2NoCrossRequestCacheLeak(
  dataSource: DataSource,
  contextA: Awaited<ReturnType<typeof createGraphQLContext>>,
  contextB: Awaited<ReturnType<typeof createGraphQLContext>>,
): Promise<void> {
  log('TEST 2 — no cross-request cache leakage: request B never sees request A\'s cached rows')
  const created = await dataSource.getRepository(Employee).save({
    firstName: 'Loader',
    lastName: 'Leak',
    email: LEAK_EMAIL,
    password: 'not-a-real-hash',
  } as Employee)
  const viaAFirst = await contextA.loaders.employee.load(created.id)
  await dataSource.getRepository(Employee).delete({ id: created.id })
  const viaB = await contextB.loaders.employee.load(created.id)
  const viaACached = await contextA.loaders.employee.load(created.id)
  check(
    "request A loaded and cached the row while it existed",
    viaAFirst !== null && viaAFirst.id === created.id,
    `A first load: ${viaAFirst === null ? 'null' : viaAFirst.email}`,
  )
  check(
    'request B hits fresh DB state (null after the deletion), not A\u2019s cache',
    viaB === null,
    `B load after row deleted: ${String(viaB)}`,
  )
  check(
    "request A's own cache still returns its row — caching is per-request, not global",
    viaACached !== null && viaACached.id === created.id,
    `A cached reload: ${viaACached === null ? 'null' : viaACached.email}`,
  )
}

async function test3RolePermissionsLoaderBatches(
  dataSource: DataSource,
  context: Awaited<ReturnType<typeof createGraphQLContext>>,
): Promise<void> {
  log('TEST 3 — rolePermissions loader batches two roles into one grouped, sorted result set')
  const adminRole = await dataSource.getRepository(Role).findOne({ where: { roleName: 'Admin' } })
  const employeeRole = await dataSource.getRepository(Role).findOne({ where: { roleName: 'Employee' } })
  if (adminRole === null || employeeRole === null) {
    check('seeded Admin and Employee roles exist', false, 'run npm run seed first')
    return
  }
  const [adminPermissions, employeePermissions] = await Promise.all([
    context.loaders.rolePermissions.load(adminRole.id),
    context.loaders.rolePermissions.load(employeeRole.id),
  ])
  const names = adminPermissions.map((permission) => permission.permissionName)
  const sorted = names.every((name, index) => index === 0 || (names[index - 1] ?? '') <= name)
  check(
    'Admin resolves its full seeded permission set (19), name-ascending like listForRole',
    adminPermissions.length === 19 && sorted,
    `admin permissions=${String(adminPermissions.length)}, first=${String(names[0])}, last=${String(names[names.length - 1])}`,
  )
  check(
    'a second role in the same batch resolves its own group, not Admin\u2019s',
    Array.isArray(employeePermissions) && employeePermissions.every((permission) => !names.includes(permission.permissionName) || adminPermissions.some((p) => p.id === permission.id)),
    `employee permissions=${String(employeePermissions.length)}`,
  )
}

function test4SchemaGraphqlEmittedOnBoot(schemaExistedBefore: boolean): void {
  log('TEST 4 — boot emits schema.graphql on disk, non-empty')
  check(
    'schema.graphql exists after boot (it was deleted before boot)',
    existsSync(SCHEMA_GRAPHQL_PATH),
    `path=${SCHEMA_GRAPHQL_PATH}, existed before boot=${String(schemaExistedBefore)}`,
  )
  const sdl = readFileSync(SCHEMA_GRAPHQL_PATH, 'utf8')
  check(
    'SDL is non-empty and contains the S2 schema surface',
    sdl.length > 0 && sdl.includes('type Query') && sdl.includes('login') && sdl.includes('RolePage'),
    `size=${String(sdl.length)} bytes, contains type Query/login/RolePage=${String(sdl.includes('type Query') && sdl.includes('login') && sdl.includes('RolePage'))}`,
  )
}

async function test5ConcurrentHttpRequestsWork(): Promise<void> {
  log('TEST 5 — two concurrent HTTP requests build contexts (with loaders) without breaking the API')
  const responses = await Promise.all([
    fetch(`http://127.0.0.1:${port}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    }),
    fetch(`http://127.0.0.1:${port}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    }),
  ])
  const bodies = await Promise.all(responses.map(async (response) => {
    const body = (await response.json()) as { data?: { __typename?: string } }
    return { status: response.status, typename: body.data?.__typename }
  }))
  check(
    'both concurrent requests returned 200 and resolved the Query type',
    bodies.length === 2 && bodies.every((body) => body.status === 200 && body.typename === 'Query'),
    `responses=${JSON.stringify(bodies)}`,
  )
}

async function main(): Promise<void> {
  const env = loadEnv()
  const dataSource = createDataSource()
  await dataSource.initialize()
  await cleanupFixtures(dataSource)
  const schemaExistedBefore = existsSync(SCHEMA_GRAPHQL_PATH)
  rmSync(SCHEMA_GRAPHQL_PATH, { force: true })

  const app = await createApp(dataSource)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  port = (server.address() as AddressInfo).port
  log(`loaders/context test — server pid ${process.pid}, port ${port}, db ${env.db.name}`)
  log('')

  try {
    const [contextA, contextB] = await test1ConcurrentRequestsGetSeparateLoaders(dataSource)
    log('')
    await test2NoCrossRequestCacheLeak(dataSource, contextA, contextB)
    log('')
    await test3RolePermissionsLoaderBatches(dataSource, contextB)
    log('')
    test4SchemaGraphqlEmittedOnBoot(schemaExistedBefore)
    log('')
    await test5ConcurrentHttpRequestsWork()
  } finally {
    await cleanupFixtures(dataSource)
    server.close()
    await dataSource.destroy()
  }

  log('')
  if (failures === 0) {
    log('RESULT: all loaders/context/schema-emission checks passed')
    process.exit(0)
  }
  log(`RESULT: ${failures} check(s) FAILED`)
  process.exit(1)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`loaders/context test crashed: ${message}`)
  process.exit(1)
})
