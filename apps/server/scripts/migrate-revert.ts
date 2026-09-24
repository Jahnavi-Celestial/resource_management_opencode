import { createDataSource } from '../src/config/data-source'

async function main(): Promise<void> {
  const dataSource = createDataSource()
  await dataSource.initialize()

  try {
    const migrationsTable = dataSource.options.migrationsTableName ?? 'migrations'
    const lastApplied = await dataSource.query(
      `SELECT "name" FROM "${migrationsTable}" ORDER BY "timestamp" DESC, "id" DESC LIMIT 1`,
    )
    if (!Array.isArray(lastApplied) || lastApplied.length === 0) {
      console.log('no applied migration to revert')
      return
    }
    const name = String(lastApplied[0]?.name)
    await dataSource.undoLastMigration({ transaction: 'each' })
    console.log(`reverted: ${name}`)
  } finally {
    await dataSource.destroy()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`migrate-revert failed: ${message}`)
  process.exit(1)
})
