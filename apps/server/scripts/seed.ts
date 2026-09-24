import { createDataSource } from '../src/config/data-source'
import { seedPermissions } from '../src/database/seeds/permissions.seed'
import { seedRoles } from '../src/database/seeds/roles.seed'
import { seedSystemEmployee } from '../src/database/seeds/system-employee.seed'
import { seedAdmin } from '../src/database/seeds/admin.seed'

async function main(): Promise<void> {
  const dataSource = createDataSource()
  await dataSource.initialize()

  try {
    await seedPermissions(dataSource)
    await seedRoles(dataSource)
    await seedSystemEmployee(dataSource)
    await seedAdmin(dataSource)
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
