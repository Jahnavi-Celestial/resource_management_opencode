import 'reflect-metadata'
import { createApp } from './app'
import { loadEnv } from './config/env'
import { createDataSource } from './config/data-source'

async function main(): Promise<void> {
  const env = loadEnv()
  const dataSource = createDataSource()
  await dataSource.initialize()

  const app = await createApp(dataSource)
  const server = app.listen(env.port, () => {
    console.log(`[${env.nodeEnv}] server listening on http://localhost:${env.port}/health`)
  })

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`received ${signal}, shutting down`)
    server.close()
    await dataSource.destroy()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`failed to start server: ${message}`)
  process.exit(1)
})
