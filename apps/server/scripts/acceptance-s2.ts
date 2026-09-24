import 'reflect-metadata'
import type { AddressInfo } from 'node:net'
import { PERMISSION_KEYS } from '@resource-booking/shared'
import type { DataSource } from 'typeorm'
import { loadEnv } from '../src/config/env'
import { createDataSource } from '../src/config/data-source'
import { createApp } from '../src/app'
import { hashPassword } from '../src/auth/password'
import { authChecker } from '../src/auth/auth-checker'
import { resolveAuthContext } from '../src/auth/resolve-auth-context'
import { AuthorisationError } from '../src/common/errors/authorisation-error'
import { SYSTEM_EMPLOYEE_EMAIL } from '../src/modules/employee/system-account'
import { Employee } from '../src/modules/employee/employee.entity'
import { Role } from '../src/modules/rbac/role.entity'

const TEST_PASSWORD = 'S2-Acceptance-Pass#1'
const NO_APPROVE_EMAIL = 's2.noapprove@local.test'
const FR16_EMAIL = 's2.fr16@local.test'
const TEMP_ADMIN_EMAIL = 's2.tempadmin@local.test'
const FR16_ROLE_NAME = 'S2 Fr16 Role'
const FIXTURE_EMAILS = [NO_APPROVE_EMAIL, FR16_EMAIL, TEMP_ADMIN_EMAIL]

interface GraphQLError {
  message: string
  extensions?: { code?: string }
}

interface GqlResponse {
  status: number
  data?: Record<string, unknown> | null
  errors?: GraphQLError[]
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

async function gql(query: string, token?: string): Promise<GqlResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== undefined) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  })
  const body = (await response.json()) as Omit<GqlResponse, 'status'>
  return { status: response.status, ...body }
}

async function loginToken(email: string, password: string): Promise<string | null> {
  const response = await gql(`mutation { login(input: { email: "${email}", password: "${password}" }) }`)
  const data = response.data as { login?: unknown } | null | undefined
  return typeof data?.login === 'string' ? data.login : null
}

function firstError(response: GqlResponse): { message: string; code: string } | null {
  const error = response.errors?.[0]
  if (error === undefined) return null
  return {
    message: error.message,
    code: typeof error.extensions?.code === 'string' ? error.extensions.code : 'UNSET',
  }
}

function describeError(response: GqlResponse): string {
  const error = firstError(response)
  if (error === null) return `no error (data=${JSON.stringify(response.data)})`
  return `"${error.message}" | ${error.code} | http=${response.status} | data=${JSON.stringify(response.data)}`
}

async function createTestEmployee(
  dataSource: DataSource,
  email: string,
  firstName: string,
): Promise<string> {
  const employee = await dataSource.getRepository(Employee).save({
    firstName,
    lastName: 'Acceptance',
    email,
    password: await hashPassword(TEST_PASSWORD),
  } as Employee)
  return employee.id
}

async function findRole(dataSource: DataSource, roleName: string): Promise<Role> {
  const role = await dataSource.getRepository(Role).findOne({ where: { roleName } })
  if (role === null) throw new Error(`role "${roleName}" not found — run npm run seed first`)
  return role
}

async function cleanupFixtures(dataSource: DataSource): Promise<void> {
  for (const email of FIXTURE_EMAILS) {
    await dataSource.getRepository(Employee).delete({ email })
  }
  await dataSource.getRepository(Role).delete({ roleName: FR16_ROLE_NAME })
}

async function test1LoginAndMe(dataSource: DataSource): Promise<string> {
  log('TEST 1 — login issues a valid JWT; me returns the permission-key union')
  const env = loadEnv()
  const token = await loginToken(env.admin.email, env.admin.password)
  check('login(admin) returns a JWT', token !== null, token === null ? 'login failed' : `${token.length} chars, prefix ${token.slice(0, 25)}…`)

  let header: Record<string, unknown> = {}
  let payload: Record<string, unknown> = {}
  if (token !== null) {
    const parts = token.split('.')
    if (parts.length === 3 && parts[0] !== undefined && parts[1] !== undefined) {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    }
  }
  check('JWT is HS256-signed with an expiry', header['alg'] === 'HS256' && typeof payload['exp'] === 'number', `alg=${String(header['alg'])}, iat=${String(payload['iat'])}, exp=${String(payload['exp'])} (expires in ${Number(payload['exp']) - Number(payload['iat'])}s)`)

  const me = await gql('query { me { employee { id email } roles { roleName } permissionKeys } }', token ?? undefined)
  const meData = me.data as { me?: { employee: { id: string; email: string }; roles: Array<{ roleName: string }>; permissionKeys: string[] } } | null | undefined
  const meValue = meData?.me
  check('me returns the admin profile and Admin role', meValue?.employee.email === env.admin.email && meValue?.roles.map((r) => r.roleName).join(',') === 'Admin', `email=${String(meValue?.employee.email)}, roles=${JSON.stringify(meValue?.roles.map((r) => r.roleName))}`)

  const actual = new Set(meValue?.permissionKeys ?? [])
  const expected = new Set<string>(PERMISSION_KEYS)
  const exactMatch = actual.size === expected.size && [...expected].every((key) => actual.has(key))
  check('me.permissionKeys equals the FR-89 catalogue exactly (19 keys)', exactMatch, `keys=${JSON.stringify([...actual].sort())}`)

  check('JWT subject is the authenticated employee id', payload['sub'] === meValue?.employee.id, `sub=${String(payload['sub'])}`)
  return token ?? ''
}

async function test2SystemLoginRefusal(): Promise<void> {
  log('TEST 2 — system employee cannot log in, with any password')
  const attempts = ['password', 'Admin@12345!', 'system', 'a'.repeat(64)]
  let allFailedIdentically = true
  for (const password of attempts) {
    const response = await gql(`mutation { login(input: { email: "${SYSTEM_EMPLOYEE_EMAIL}", password: "${password}" }) }`)
    const error = firstError(response)
    const ok = error !== null && error.message === 'Invalid email or password' && error.code === 'UNAUTHENTICATED'
    allFailedIdentically = allFailedIdentically && ok
    log(`         ${SYSTEM_EMPLOYEE_EMAIL} + pw '${password.slice(0, 10)}…' → ${describeError(response)}`)
  }
  check('every system-account login attempt fails as invalid credentials', allFailedIdentically, `${attempts.length} attempts, identical UNAUTHENTICATED response`)

  const env = loadEnv()
  const wrongPassword = await gql(`mutation { login(input: { email: "${env.admin.email}", password: "definitely-wrong" }) }`)
  const wrongPasswordError = firstError(wrongPassword)
  const systemError = firstError(await gql(`mutation { login(input: { email: "${SYSTEM_EMPLOYEE_EMAIL}", password: "password" }) }`))
  check(
    'response is indistinguishable from an ordinary failed login',
    wrongPasswordError !== null && systemError !== null && wrongPasswordError.message === systemError.message && wrongPasswordError.code === systemError.code,
    `admin+wrong-pw → "${String(wrongPasswordError?.message)}" | ${String(wrongPasswordError?.code)}`,
  )
}

async function test3GenericAuthorisationError(dataSource: DataSource, adminToken: string, noApproveEmployeeId: string): Promise<void> {
  log('TEST 3 — caller without booking:approve gets a generic authorisation error')
  const rolesQuery = await gql('query { roles(page: 1, pageSize: 10) { items { id roleName } } }', adminToken)
  const rolesData = rolesQuery.data as { roles?: { items: Array<{ id: string; roleName: string }> } } | null | undefined
  const employeeRole = rolesData?.roles?.items.find((r) => r.roleName === 'Employee')
  if (employeeRole === undefined) throw new Error('seeded "Employee" role not found')
  await gql(`mutation { assignRoleToEmployee(input: { employeeId: "${noApproveEmployeeId}", roleId: "${employeeRole.id}" }) { email } }`, adminToken)

  const token = await loginToken(NO_APPROVE_EMAIL, TEST_PASSWORD)
  const me = await gql('query { me { permissionKeys } }', token ?? undefined)
  const meData = me.data as { me?: { permissionKeys: string[] } } | null | undefined
  const keys = meData?.me?.permissionKeys ?? []
  check('employee holds the seeded Employee role (no booking:approve in union)', !keys.includes('booking:approve'), `permissionKeys=${JSON.stringify(keys)}`)

  const createRoleCall = await gql('mutation { createRole(input: { roleName: "should never exist" }) { id } }', token ?? undefined)
  const createRoleError = firstError(createRoleCall)
  check('permission-gated mutation rejected with a generic error', createRoleError !== null && createRoleError.message === 'Not authorised' && createRoleError.code === 'FORBIDDEN' && createRoleCall.data === null, `createRole (needs role:write) → ${describeError(createRoleCall)}`)

  const rolesCall = await gql('query { roles(page: 1, pageSize: 10) { total } }', token ?? undefined)
  const rolesError = firstError(rolesCall)
  check('permission-gated query rejected identically', rolesError !== null && rolesError.message === 'Not authorised' && rolesError.code === 'FORBIDDEN', `roles (needs role:read) → ${describeError(rolesCall)}`)

  const anonymousCall = await gql('mutation { createRole(input: { roleName: "should never exist" }) { id } }')
  const anonymousError = firstError(anonymousCall)
  check('rejection is indistinguishable from an unauthenticated call', anonymousError?.message === createRoleError?.message && anonymousError?.code === createRoleError?.code, `no-token createRole → ${describeError(anonymousCall)}`)

  const resolved = await resolveAuthContext(dataSource, token ?? undefined)
  const resolverData = { context: { dataSource, auth: resolved } } as Parameters<typeof authChecker>[0]
  const ownPermissionAllowed = authChecker(resolverData, ['room:read'])
  let bookingApproveError: unknown
  try {
    authChecker(resolverData, ['booking:approve'])
  } catch (error: unknown) {
    bookingApproveError = error
  }
  check(
    "authChecker(['booking:approve']) rejects this caller, ['room:read'] admits them",
    ownPermissionAllowed === true && bookingApproveError instanceof AuthorisationError && bookingApproveError.message === 'Not authorised',
    "authChecker(ctx, ['room:read']) → true; authChecker(ctx, ['booking:approve']) → throws AuthorisationError 'Not authorised'",
  )
  log('         note: the first booking:approve-gated resolver arrives in S8; the checker is the single permission-key code path used by every @Authorized resolver')
}

async function test4LivePermissionRevocation(dataSource: DataSource, adminToken: string, fr16EmployeeId: string): Promise<void> {
  log('TEST 4 — revoked permission takes effect on the very next request (no restart)')
  const permissionsQuery = await gql('query { permissions(page: 1, pageSize: 50) { items { id permissionName } } }', adminToken)
  const permissionsData = permissionsQuery.data as { permissions?: { items: Array<{ id: string; permissionName: string }> } } | null | undefined
  const permissionId = (name: string): string => {
    const found = permissionsData?.permissions?.items.find((p) => p.permissionName === name)
    if (found === undefined) throw new Error(`permission "${name}" not found`)
    return found.id
  }

  const createdRole = await gql(`mutation { createRole(input: { roleName: "${FR16_ROLE_NAME}" }) { id roleName } }`, adminToken)
  const createdRoleData = createdRole.data as { createRole?: { id: string } } | null | undefined
  const roleId = createdRoleData?.createRole?.id
  if (roleId === undefined) throw new Error(`failed to create "${FR16_ROLE_NAME}": ${describeError(createdRole)}`)
  await gql(`mutation { assignPermissionToRole(input: { roleId: "${roleId}", permissionId: "${permissionId('role:read')}" }) { roleName } }`, adminToken)
  await gql(`mutation { assignPermissionToRole(input: { roleId: "${roleId}", permissionId: "${permissionId('booking:approve')}" }) { roleName } }`, adminToken)
  await gql(`mutation { assignRoleToEmployee(input: { employeeId: "${fr16EmployeeId}", roleId: "${roleId}" }) { email } }`, adminToken)

  const token = await loginToken(FR16_EMAIL, TEST_PASSWORD)
  const meBefore = await gql('query { me { permissionKeys } }', token ?? undefined)
  const beforeKeys = ((meBefore.data as { me?: { permissionKeys: string[] } } | null | undefined)?.me?.permissionKeys ?? []).sort()
  check('employee starts with [booking:approve, role:read]', beforeKeys.join(',') === 'booking:approve,role:read', `permissionKeys=${JSON.stringify(beforeKeys)}`)

  const rolesBefore = await gql('query { roles(page: 1, pageSize: 10) { total } }', token ?? undefined)
  const rolesBeforeTotal = (rolesBefore.data as { roles?: { total: number } } | null | undefined)?.roles?.total
  check('gated query succeeds while the role holds role:read', firstError(rolesBefore) === null && typeof rolesBeforeTotal === 'number' && rolesBeforeTotal >= 3, `roles.total=${String(rolesBeforeTotal)} (3 seeded roles + "${FR16_ROLE_NAME}")`)

  await gql(`mutation { removePermissionFromRole(input: { roleId: "${roleId}", permissionId: "${permissionId('role:read')}" }) { roleName } }`, adminToken)
  log('         admin revoked role:read from the role (same server process, pid unchanged)')

  const rolesAfter = await gql('query { roles(page: 1, pageSize: 10) { total } }', token ?? undefined)
  const rolesAfterError = firstError(rolesAfter)
  check('immediately after: same token now rejected on that query', rolesAfterError !== null && rolesAfterError.message === 'Not authorised' && rolesAfterError.code === 'FORBIDDEN', `roles → ${describeError(rolesAfter)}`)

  const meAfter = await gql('query { me { permissionKeys } }', token ?? undefined)
  const afterKeys = ((meAfter.data as { me?: { permissionKeys: string[] } } | null | undefined)?.me?.permissionKeys ?? []).sort()
  check('me now resolves without the revoked key', afterKeys.join(',') === 'booking:approve', `permissionKeys=${JSON.stringify(afterKeys)}`)

  await gql(`mutation { removePermissionFromRole(input: { roleId: "${roleId}", permissionId: "${permissionId('booking:approve')}" }) { roleName } }`, adminToken)
  const meEmpty = await gql('query { me { permissionKeys } }', token ?? undefined)
  const emptyKeys = (meEmpty.data as { me?: { permissionKeys: string[] } } | null | undefined)?.me?.permissionKeys ?? []
  check('fully-revoked role leaves an authenticated user with zero permissions', emptyKeys.length === 0, `permissionKeys=${JSON.stringify(emptyKeys)} (me still succeeds — authentication is separate from permission)`)
  void dataSource
}

async function test5LockoutGuard(adminToken: string, adminEmployeeId: string, tempAdminEmployeeId: string): Promise<void> {
  log('TEST 5 — the last role:assign holder cannot be removed via any path')
  const rolesQuery = await gql('query { roles(page: 1, pageSize: 10) { items { id roleName } } }', adminToken)
  const adminRole = ((rolesQuery.data as { roles?: { items: Array<{ id: string; roleName: string }> } } | null | undefined)?.roles?.items ?? []).find((r) => r.roleName === 'Admin')
  if (adminRole === undefined) throw new Error('seeded "Admin" role not found')
  const permissionsQuery = await gql('query { permissions(page: 1, pageSize: 50) { items { id permissionName } } }', adminToken)
  const roleAssign = ((permissionsQuery.data as { permissions?: { items: Array<{ id: string; permissionName: string }> } } | null | undefined)?.permissions?.items ?? []).find((p) => p.permissionName === 'role:assign')
  if (roleAssign === undefined) throw new Error('role:assign permission not found')

  const pathA = await gql(`mutation { deleteRole(id: "${adminRole.id}") }`, adminToken)
  const pathAError = firstError(pathA)
  check(
    'path A: deleteRole(Admin) rejected with a clear LOCKOUT_GUARD error (no 500)',
    pathAError !== null && pathAError.code === 'LOCKOUT_GUARD' && pathA.status === 200 && pathA.data === null && pathAError.message.includes('role:assign'),
    `→ ${describeError(pathA)}`,
  )

  const pathB = await gql(`mutation { removePermissionFromRole(input: { roleId: "${adminRole.id}", permissionId: "${roleAssign.id}" }) { roleName } }`, adminToken)
  const pathBError = firstError(pathB)
  check(
    'path B: removePermissionFromRole(Admin, role:assign) rejected',
    pathBError !== null && pathBError.code === 'LOCKOUT_GUARD' && pathB.status === 200 && pathB.data === null && pathBError.message.includes('role:assign'),
    `→ ${describeError(pathB)}`,
  )

  const pathC = await gql(`mutation { removeRoleFromEmployee(input: { employeeId: "${adminEmployeeId}", roleId: "${adminRole.id}" }) { email } }`, adminToken)
  const pathCError = firstError(pathC)
  check(
    'path C: removeRoleFromEmployee(bootstrap admin, Admin) rejected',
    pathCError !== null && pathCError.code === 'LOCKOUT_GUARD' && pathC.status === 200 && pathC.data === null && pathCError.message.includes('role:assign'),
    `→ ${describeError(pathC)}`,
  )

  const roleStillThere = await gql(`query { role(id: "${adminRole.id}") { roleName permissions { permissionName } } }`, adminToken)
  const roleStillThereData = roleStillThere.data as { role?: { roleName: string; permissions: Array<{ permissionName: string }> } } | null | undefined
  check('state intact after all three rejections', roleStillThereData?.role?.roleName === 'Admin' && (roleStillThereData?.role?.permissions.length ?? 0) === 19, `role(Admin) still exists with ${String(roleStillThereData?.role?.permissions.length)} permissions`)

  const me = await gql('query { me { roles { roleName } permissionKeys } }', adminToken)
  const meData = me.data as { me?: { roles: Array<{ roleName: string }>; permissionKeys: string[] } } | null | undefined
  check('bootstrap admin unchanged', meData?.me?.roles.map((r) => r.roleName).join(',') === 'Admin' && (meData?.me?.permissionKeys.length ?? 0) === 19, `roles=Admin, permissionKeys=19`)

  const assignTemp = await gql(`mutation { assignRoleToEmployee(input: { employeeId: "${tempAdminEmployeeId}", roleId: "${adminRole.id}" }) { email } }`, adminToken)
  const removeTemp = await gql(`mutation { removeRoleFromEmployee(input: { employeeId: "${tempAdminEmployeeId}", roleId: "${adminRole.id}" }) { email } }`, adminToken)
  check('negative control: removing Admin from a second holder is allowed', firstError(assignTemp) === null && firstError(removeTemp) === null, `second employee assigned+removed Admin while bootstrap admin still holds it`)
}

async function test6NoPasswordFieldInSchema(): Promise<void> {
  log('TEST 6 — Employee has no password field anywhere in the schema')
  const employeeType = await gql('query { __type(name: "Employee") { name fields { name } } }')
  const employeeTypeData = (employeeType.data as { __type?: { name: string; fields: Array<{ name: string }> | null } } | null | undefined)?.__type
  const fieldNames = employeeTypeData?.fields?.map((f) => f.name) ?? []
  check('Employee type exposes exactly the safe profile fields', fieldNames.sort().join(',') === 'createdAt,email,firstName,id,lastName,updatedAt', `fields=${JSON.stringify(fieldNames.sort())}`)

  const fullSchema = await gql('query { __schema { queryType { name } mutationType { name } types { name fields { name } } } }')
  const schemaData = fullSchema.data as { __schema?: { queryType: { name: string }; mutationType: { name: string }; types: Array<{ name: string; fields: Array<{ name: string }> | null }> } } | null | undefined
  const types = schemaData?.__schema?.types ?? []
  const offenders: string[] = []
  let fieldCount = 0
  for (const type of types) {
    for (const field of type.fields ?? []) {
      fieldCount += 1
      if (/password/i.test(field.name)) offenders.push(`${type.name}.${field.name}`)
    }
  }
  check('no field matching /password/i exists on any type in the entire schema', offenders.length === 0, `scanned ${String(types.length)} types / ${String(fieldCount)} fields; query=${String(schemaData?.__schema?.queryType?.name)}, mutation=${String(schemaData?.__schema?.mutationType?.name)}; matches=${JSON.stringify(offenders)}`)
}

async function main(): Promise<void> {
  const env = loadEnv()
  const dataSource = createDataSource()
  await dataSource.initialize()
  await cleanupFixtures(dataSource)

  const app = await createApp(dataSource)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  port = (server.address() as AddressInfo).port
  log(`S2 acceptance suite — server pid ${process.pid}, port ${port}, db ${env.db.name}`)
  log('')

  let adminToken = ''
  try {
    adminToken = await test1LoginAndMe(dataSource)

    const me = await gql('query { me { employee { id } } }', adminToken)
    const adminEmployeeId = (me.data as { me?: { employee: { id: string } } } | null | undefined)?.me?.employee?.id ?? ''

    const noApproveEmployeeId = await createTestEmployee(dataSource, NO_APPROVE_EMAIL, 'NoApprove')
    const fr16EmployeeId = await createTestEmployee(dataSource, FR16_EMAIL, 'FrSixteen')
    const tempAdminEmployeeId = await createTestEmployee(dataSource, TEMP_ADMIN_EMAIL, 'TempAdmin')

    log('')
    await test2SystemLoginRefusal()
    log('')
    await test3GenericAuthorisationError(dataSource, adminToken, noApproveEmployeeId)
    log('')
    await test4LivePermissionRevocation(dataSource, adminToken, fr16EmployeeId)
    log('')
    await test5LockoutGuard(adminToken, adminEmployeeId, tempAdminEmployeeId)
    log('')
    await test6NoPasswordFieldInSchema()
  } finally {
    log('')
    await cleanupFixtures(dataSource)
    const counts = await dataSource.query<{ employees: string; roles: string; permissions: string; role_permissions: string; user_roles: string }[]>(
      'SELECT (SELECT count(*) FROM employee) AS employees, (SELECT count(*) FROM role) AS roles, (SELECT count(*) FROM permission) AS permissions, (SELECT count(*) FROM role_permission) AS role_permissions, (SELECT count(*) FROM user_role) AS user_roles',
    )
    const count = counts[0]
    log(`fixtures cleaned — seed state: employees=${count?.employees}, roles=${count?.roles}, permissions=${count?.permissions}, role_permissions=${count?.role_permissions}, user_roles=${count?.user_roles} (pid still ${process.pid})`)
    server.close()
    await dataSource.destroy()
  }

  log('')
  if (failures === 0) {
    log('RESULT: all S2 acceptance checks passed')
    process.exit(0)
  }
  log(`RESULT: ${failures} check(s) FAILED`)
  process.exit(1)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`acceptance suite crashed: ${message}`)
  process.exit(1)
})
