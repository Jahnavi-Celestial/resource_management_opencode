import 'reflect-metadata'
import type { AddressInfo } from 'node:net'
import type { DataSource } from 'typeorm'
import { loadEnv } from '../src/config/env'
import { createDataSource } from '../src/config/data-source'
import { createApp } from '../src/app'
import { hashPassword } from '../src/auth/password'
import { Employee } from '../src/modules/employee/employee.entity'
import { Permission } from '../src/modules/rbac/permission.entity'
import { Role } from '../src/modules/rbac/role.entity'
import { RolePermission } from '../src/modules/rbac/role-permission.entity'
import { UserRole } from '../src/modules/rbac/user-role.entity'

const TEST_PASSWORD = 'RA-Acceptance-Pass#1'
const ROLE_PREFIX = 'ra-'
const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000'

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
let dataSource: DataSource
const createdRoleIds: string[] = []
const createdEmployeeIds: string[] = []

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
  return `"${error.message}" | ${error.code} | http=${response.status}`
}

async function createTestEmployee(email: string, firstName: string): Promise<string> {
  const employee = await dataSource.getRepository(Employee).save({
    firstName,
    lastName: 'Acceptance',
    email,
    password: await hashPassword(TEST_PASSWORD),
  } as Employee)
  return employee.id
}

async function findRoleByName(roleName: string): Promise<Role | null> {
  return dataSource.getRepository(Role).findOne({ where: { roleName } })
}

async function findPermissionByName(permissionName: string): Promise<Permission | null> {
  return dataSource.getRepository(Permission).findOne({ where: { permissionName } })
}

async function createRoleWithPermissions(
  token: string,
  roleName: string,
  permissionIds: readonly string[],
): Promise<GqlResponse> {
  const ids = permissionIds.map((id) => `"${id}"`).join(', ')
  return gql(
    `mutation { createRole(input: { roleName: "${roleName}", permissionIds: [${ids}] }) { id roleName } }`,
    token,
  )
}

async function cleanupFixtures(): Promise<void> {
  for (const roleId of createdRoleIds) {
    await dataSource.getRepository(RolePermission).delete({ roleId })
    await dataSource.getRepository(Role).delete({ id: roleId })
  }
  for (const employeeId of createdEmployeeIds) {
    await dataSource.getRepository(UserRole).delete({ employeeId })
    await dataSource.getRepository(Employee).delete({ id: employeeId })
  }
}

async function test1DuplicateRoleName(token: string): Promise<void> {
  log('TEST 1 — duplicate role name refused: exact, case-variant and padded')
  const exact = await gql('mutation { createRole(input: { roleName: "Admin" }) { id } }', token)
  check('exact duplicate "Admin" → CONFLICT', firstError(exact)?.code === 'CONFLICT', describeError(exact))
  const variant = await gql('mutation { createRole(input: { roleName: "admin" }) { id } }', token)
  check('case-variant "admin" → CONFLICT (case-insensitive index)', firstError(variant)?.code === 'CONFLICT', describeError(variant))
  const padded = await gql('mutation { createRole(input: { roleName: "  Admin  " }) { id } }', token)
  check('padded "  Admin  " → CONFLICT (trim then case-fold)', firstError(padded)?.code === 'CONFLICT', describeError(padded))
  const upper = await gql('mutation { createRole(input: { roleName: "ADMIN" }) { id } }', token)
  check('upper-case "ADMIN" → CONFLICT', firstError(upper)?.code === 'CONFLICT', describeError(upper))
}

async function test2CreateWithPermissions(token: string): Promise<void> {
  log('TEST 2 — createRole with permissionIds writes role + grants in one transaction')
  const perms = await gql(
    'query { permissions(page: 1, pageSize: 100) { total items { id permissionName } } }',
    token,
  )
  const items = (
    perms.data as { permissions: { total: number; items: Array<{ id: string; permissionName: string }> } }
  ).permissions.items
  check('permission catalogue is readable (19 keys)', items.length === 19, `got ${String(items.length)}`)
  const picked = items.filter((p) => p.permissionName === 'room:read' || p.permissionName === 'equipment:read')
  const roleName = `${ROLE_PREFIX}with-perms`
  const created = await createRoleWithPermissions(
    token,
    roleName,
    picked.map((p) => p.id),
  )
  const createdData = created.data as { createRole?: { id: string; roleName: string } } | null | undefined
  check('createRole with 2 permissionIds succeeds', createdData?.createRole !== undefined, describeError(created))
  if (createdData?.createRole === undefined) return
  createdRoleIds.push(createdData.createRole.id)
  const fetched = await gql(
    `query { role(id: "${createdData.createRole.id}") { roleName permissions { permissionName } } }`,
    token,
  )
  const roleData = fetched.data as {
    role?: { roleName: string; permissions: Array<{ permissionName: string }> }
  } | null | undefined
  const names = (roleData?.role?.permissions ?? []).map((p) => p.permissionName).sort()
  check(
    'role comes back with exactly the 2 granted permissions',
    names.length === 2 && names[0] === 'equipment:read' && names[1] === 'room:read',
    `permissions=${JSON.stringify(names)}`,
  )
}

async function test3AtomicRollback(token: string): Promise<void> {
  log('TEST 3 — an unknown permissionId rolls the whole create back (no orphan role)')
  const perms = await gql('query { permissions(page: 1, pageSize: 100) { items { id } } }', token)
  const validId = (
    (perms.data as { permissions: { items: Array<{ id: string }> } }).permissions.items[0] as { id: string }
  ).id
  const roleName = `${ROLE_PREFIX}orphan`
  const created = await gql(
    `mutation { createRole(input: { roleName: "${roleName}", permissionIds: ["${validId}", "${NON_EXISTENT_UUID}"] }) { id } }`,
    token,
  )
  check('createRole with an unknown permissionId → error', firstError(created) !== null, describeError(created))
  const leftover = await findRoleByName(roleName)
  check('no role row left behind (transaction rolled back)', leftover === null, `leftover=${JSON.stringify(leftover)}`)
}

async function test4DuplicatePermissionIds(token: string): Promise<void> {
  log('TEST 4 — repeated permissionId is deduped, not a 23505')
  const roomRead = await findPermissionByName('room:read')
  if (roomRead === null) {
    check('room:read permission present', false, 'run npm run seed first')
    return
  }
  const roleName = `${ROLE_PREFIX}dup-perm`
  const created = await gql(
    `mutation { createRole(input: { roleName: "${roleName}", permissionIds: ["${roomRead.id}", "${roomRead.id}"] }) { id } }`,
    token,
  )
  const createdData = created.data as { createRole?: { id: string } } | null | undefined
  check('createRole with the same id twice succeeds', createdData?.createRole !== undefined, describeError(created))
  if (createdData?.createRole === undefined) return
  createdRoleIds.push(createdData.createRole.id)
  const links = await dataSource.getRepository(RolePermission).find({ where: { roleId: createdData.createRole.id } })
  check('exactly one link written (deduped)', links.length === 1, `links=${String(links.length)}`)
}

async function test5UpdateRoleCase(token: string): Promise<void> {
  log("TEST 5 — updateRole: own name in another case allowed, another role's case-variant refused")
  const one = await gql(`mutation { createRole(input: { roleName: "${ROLE_PREFIX}case-one" }) { id } }`, token)
  const oneData = one.data as { createRole?: { id: string } } | null | undefined
  const two = await gql(`mutation { createRole(input: { roleName: "${ROLE_PREFIX}case-two" }) { id } }`, token)
  const twoData = two.data as { createRole?: { id: string } } | null | undefined
  if (oneData?.createRole === undefined || twoData?.createRole === undefined) {
    check('fixture roles created', false, `${describeError(one)} / ${describeError(two)}`)
    return
  }
  createdRoleIds.push(oneData.createRole.id, twoData.createRole.id)
  const ownCase = await gql(
    `mutation { updateRole(input: { id: "${oneData.createRole.id}", roleName: "${ROLE_PREFIX}CASE-ONE" }) { id roleName } }`,
    token,
  )
  check(
    'rename to own name in different case succeeds (no false conflict)',
    (ownCase.data as { updateRole?: { roleName: string } } | null | undefined)?.updateRole !== undefined,
    describeError(ownCase),
  )
  const otherCase = await gql(
    `mutation { updateRole(input: { id: "${twoData.createRole.id}", roleName: "${ROLE_PREFIX}case-one" }) { id } }`,
    token,
  )
  check(
    "rename onto another role's case-variant → CONFLICT",
    firstError(otherCase)?.code === 'CONFLICT',
    describeError(otherCase),
  )
}

async function test6ConcurrentCreate(token: string): Promise<void> {
  log('TEST 6 — two concurrent creates of the same name: one wins, one CONFLICT')
  const roleName = `${ROLE_PREFIX}race`
  const [a, b] = await Promise.all([
    gql(`mutation { createRole(input: { roleName: "${roleName}" }) { id } }`, token),
    gql(`mutation { createRole(input: { roleName: "${roleName}" }) { id } }`, token),
  ])
  const aData = (a.data as { createRole?: { id: string } } | null | undefined)?.createRole
  const bData = (b.data as { createRole?: { id: string } } | null | undefined)?.createRole
  const aOk = aData !== undefined
  const bOk = bData !== undefined
  check('exactly one create succeeds', aOk !== bOk, `a=${describeError(a)}, b=${describeError(b)}`)
  const loser = aOk ? b : a
  check('the loser is a CONFLICT', firstError(loser)?.code === 'CONFLICT', describeError(loser))
  const winnerId = aOk ? aData?.id : bData?.id
  if (winnerId !== undefined) createdRoleIds.push(winnerId)
}

async function test7Gating(): Promise<void> {
  log('TEST 7 — role:write gates createRole and the permission mutations')
  const employeeRole = await findRoleByName('Employee')
  if (employeeRole === null) {
    check('seeded Employee role present', false, 'run npm run seed first')
    return
  }
  const employeeEmail = 'ra+employee@local.test'
  const employeeId = await createTestEmployee(employeeEmail, 'RA')
  await dataSource.getRepository(UserRole).save({ employeeId, roleId: employeeRole.id } as UserRole)
  const employeeToken = await loginToken(employeeEmail, TEST_PASSWORD)
  check('fixture employee can log in', employeeToken !== null, 'login failed')
  if (employeeToken === null) return
  createdEmployeeIds.push(employeeId)

  const forbiddenCreate = await gql(
    `mutation { createRole(input: { roleName: "${ROLE_PREFIX}forbidden" }) { id } }`,
    employeeToken,
  )
  check('createRole without role:write → FORBIDDEN', firstError(forbiddenCreate)?.code === 'FORBIDDEN', describeError(forbiddenCreate))

  const writeRoleName = `${ROLE_PREFIX}write-only`
  const writeRole = await dataSource.getRepository(Role).save({ roleName: writeRoleName } as Role)
  createdRoleIds.push(writeRole.id)
  const writePermission = await findPermissionByName('role:write')
  if (writePermission !== null) {
    await dataSource
      .getRepository(RolePermission)
      .save({ roleId: writeRole.id, permissionId: writePermission.id } as RolePermission)
  }
  const writeEmail = 'ra+writeonly@local.test'
  const writeEmployeeId = await createTestEmployee(writeEmail, 'RAWO')
  await dataSource.getRepository(UserRole).save({ employeeId: writeEmployeeId, roleId: writeRole.id } as UserRole)
  const writeToken = await loginToken(writeEmail, TEST_PASSWORD)
  check('write-only employee can log in', writeToken !== null, 'login failed')
  if (writeToken === null) return
  createdEmployeeIds.push(writeEmployeeId)

  const allowedCreate = await gql(
    `mutation { createRole(input: { roleName: "${ROLE_PREFIX}allowed" }) { id } }`,
    writeToken,
  )
  const allowedData = (allowedCreate.data as { createRole?: { id: string } } | null | undefined)?.createRole
  check('createRole with role:write succeeds', allowedData !== undefined, describeError(allowedCreate))
  if (allowedData !== undefined) createdRoleIds.push(allowedData.id)

  const targetRole = allowedData ?? writeRole
  const roomRead = await findPermissionByName('room:read')
  if (roomRead === null) {
    check('room:read permission present', false, 'run npm run seed first')
    return
  }
  const allowedAssign = await gql(
    `mutation { assignPermissionToRole(input: { roleId: "${targetRole.id}", permissionId: "${roomRead.id}" }) { id } }`,
    writeToken,
  )
  check(
    'assignPermissionToRole with role:write succeeds (gated on role:write, not role:assign)',
    (allowedAssign.data as { assignPermissionToRole?: { id: string } } | null | undefined)?.assignPermissionToRole !== undefined,
    describeError(allowedAssign),
  )
  const forbiddenAssign = await gql(
    `mutation { assignPermissionToRole(input: { roleId: "${targetRole.id}", permissionId: "${roomRead.id}" }) { id } }`,
    employeeToken,
  )
  check(
    'assignPermissionToRole without role:write → FORBIDDEN',
    firstError(forbiddenAssign)?.code === 'FORBIDDEN',
    describeError(forbiddenAssign),
  )
}

async function test8SystemRolesProtected(token: string): Promise<void> {
  log('TEST 8 — the seeded system roles cannot be deleted or renamed')
  const systemNames = ['Admin', 'Manager', 'Employee']
  const systemRoles: Role[] = []
  for (const name of systemNames) {
    const role = await findRoleByName(name)
    if (role === null) {
      check(`seeded ${name} role present`, false, 'run npm run seed first')
      return
    }
    systemRoles.push(role)
  }

  const grantCount = async (roleId: string): Promise<number> =>
    dataSource.getRepository(RolePermission).count({ where: { roleId } })
  const grantsBefore = new Map<string, number>()
  for (const role of systemRoles) grantsBefore.set(role.id, await grantCount(role.id))

  for (const role of systemRoles) {
    const deleted = await gql(`mutation { deleteRole(id: "${role.id}") }`, token)
    check(
      `deleteRole(${role.roleName}) → SYSTEM_ROLE`,
      firstError(deleted)?.code === 'SYSTEM_ROLE' && deleted.status === 200 && deleted.data === null,
      describeError(deleted),
    )
  }

  for (const role of systemRoles) {
    const still = await findRoleByName(role.roleName)
    check(`${role.roleName} still exists after the refusal`, still !== null, `role(${role.roleName}) is gone`)
    if (still !== null) {
      const after = await grantCount(still.id)
      check(
        `${role.roleName} grants intact after the refusal`,
        after === grantsBefore.get(role.id),
        `grants ${String(grantsBefore.get(role.id))} → ${String(after)}`,
      )
    }
  }

  const admin = systemRoles.find((role) => role.roleName === 'Admin')
  if (admin === undefined) {
    check('Admin role present', false, 'run npm run seed first')
    return
  }
  const rename = await gql(
    `mutation { updateRole(input: { id: "${admin.id}", roleName: "Superuser" }) { id roleName } }`,
    token,
  )
  check('updateRole(Admin, "Superuser") → SYSTEM_ROLE', firstError(rename)?.code === 'SYSTEM_ROLE', describeError(rename))
  const caseOnly = await gql(
    `mutation { updateRole(input: { id: "${admin.id}", roleName: "admin" }) { id } }`,
    token,
  )
  check(
    'updateRole(Admin, "admin") case-only rename → SYSTEM_ROLE (seedAdmin looks the name up exactly)',
    firstError(caseOnly)?.code === 'SYSTEM_ROLE',
    describeError(caseOnly),
  )
  const noOp = await gql(
    `mutation { updateRole(input: { id: "${admin.id}", roleName: "Admin" }) { id roleName } }`,
    token,
  )
  check(
    'updateRole(Admin, "Admin") no-op succeeds (permission editing still works)',
    (noOp.data as { updateRole?: { roleName: string } } | null | undefined)?.updateRole !== undefined,
    describeError(noOp),
  )
  const adminAfter = await findRoleByName('Admin')
  check(
    'Admin name unchanged after every refusal',
    adminAfter !== null && adminAfter.roleName === 'Admin',
    `name=${adminAfter?.roleName ?? 'gone'}`,
  )

  const custom = await gql(`mutation { createRole(input: { roleName: "${ROLE_PREFIX}deletable" }) { id } }`, token)
  const customData = custom.data as { createRole?: { id: string } } | null | undefined
  check('a custom role can still be created', customData?.createRole !== undefined, describeError(custom))
  if (customData?.createRole !== undefined) {
    createdRoleIds.push(customData.createRole.id)
    const deleted = await gql(`mutation { deleteRole(id: "${customData.createRole.id}") }`, token)
    check(
      'a custom role is still deletable (rule is not over-broad)',
      deleted.data !== null && firstError(deleted) === null,
      describeError(deleted),
    )
  }
}

async function main(): Promise<void> {
  const env = loadEnv()
  dataSource = createDataSource()
  await dataSource.initialize()
  const app = await createApp(dataSource)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  port = (server.address() as AddressInfo).port
  log(`role acceptance test — server pid ${process.pid}, port ${port}, db ${env.db.name}`)
  log('')

  try {
    const token = await loginToken(env.admin.email, env.admin.password)
    check('admin login succeeds', token !== null, 'login failed')
    if (token === null) return
    await test1DuplicateRoleName(token)
    log('')
    await test2CreateWithPermissions(token)
    log('')
    await test3AtomicRollback(token)
    log('')
    await test4DuplicatePermissionIds(token)
    log('')
    await test5UpdateRoleCase(token)
    log('')
    await test6ConcurrentCreate(token)
    log('')
    await test7Gating()
    log('')
    await test8SystemRolesProtected(token)
  } finally {
    await cleanupFixtures()
    server.close()
    await dataSource.destroy()
  }

  log('')
  if (failures === 0) {
    log('RESULT: all role acceptance checks passed')
    process.exit(0)
  }
  log(`RESULT: ${failures} check(s) FAILED`)
  process.exit(1)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`role acceptance test crashed: ${message}`)
  process.exit(1)
})
