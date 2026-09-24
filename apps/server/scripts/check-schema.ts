import { createDataSource } from '../src/config/data-source'

async function main(): Promise<void> {
  const dataSource = createDataSource()
  await dataSource.initialize()

  try {
    const sqlInMemory = await dataSource.driver.createSchemaBuilder().log()
    if (sqlInMemory.upQueries.length === 0) {
      console.log('schema in sync with entities — no drift')
      return
    }
    console.log(`drift detected — ${sqlInMemory.upQueries.length} statement(s) that synchronize would run:`)
    for (const query of sqlInMemory.upQueries) {
      console.log(query.query)
    }
    process.exitCode = 1
  } finally {
    await dataSource.destroy()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`check-schema failed: ${message}`)
  process.exit(1)
})
