import { createDataSource } from '../src/config/data-source'

async function main(): Promise<void> {
  const dataSource = createDataSource()
  await dataSource.initialize()

  try {
    const migrations = await dataSource.runMigrations({ transaction: 'each' })
    if (migrations.length === 0) {
      console.log('no pending migrations')
      return
    }
    for (const migration of migrations) {
      console.log(`applied: ${migration.name}`)
    }
  } finally {
    await dataSource.destroy()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`migrate failed: ${message}`)
  process.exit(1)
})
