import { createDataSource } from '../src/config/data-source'
import { loadEnv } from '../src/config/env'
import { seedPermissions } from '../src/database/seeds/permissions.seed'
import { seedRoles } from '../src/database/seeds/roles.seed'
import { seedSystemEmployee } from '../src/database/seeds/system-employee.seed'
import { seedBootstrapPerson } from '../src/database/seeds/bootstrap-person.seed'
import { ADMIN_ROLE_NAME } from '../src/modules/rbac/system-roles'

async function main(): Promise<void> {
  const env = loadEnv()
  const { admin, manager, employee } = env

  // Permissions are the union of an employee's roles, so two seeded people
  // sharing an address would silently acquire both role sets — the Manager would
  // end up approving bookings as an Admin. Fail loudly instead.
  const emails = [admin.email, manager.email, employee.email]
  if (new Set(emails).size !== emails.length) {
    throw new Error(
      `ADMIN_EMAIL, MANAGER_EMAIL and EMPLOYEE_EMAIL must be three different addresses, got: ${emails.join(', ')}`,
    )
  }

  const dataSource = createDataSource()
  await dataSource.initialize()

  try {
    await seedPermissions(dataSource)
    await seedRoles(dataSource)
    await seedSystemEmployee(dataSource)
    // Admin, then Manager, then Employee. The order is not load-bearing — every
    // one of these looks its role up by exact name — but Admin first means the
    // distinctness guard above is the only thing that can ever put two roles on
    // one person.
    await seedBootstrapPerson(dataSource, {
      ...admin,
      roleName: ADMIN_ROLE_NAME,
      firstName: 'Yug',
      lastName: 'Sharma',
    })
    await seedBootstrapPerson(dataSource, {
      ...manager,
      roleName: 'Manager',
      firstName: 'Rishi',
      lastName: 'Manager',
    })
    await seedBootstrapPerson(dataSource, {
      ...employee,
      roleName: 'Employee',
      firstName: 'Pallavi',
      lastName: 'Pathak',
    })
    console.log('seed complete')
  } finally {
    await dataSource.destroy()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`seed failed: ${message}`)
  process.exit(1)
})
