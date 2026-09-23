import { Client } from 'pg'
import { loadEnv } from '../src/config/env'

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

async function main(): Promise<void> {
  const env = loadEnv()

  const admin = new Client({
    host: env.db.host,
    port: env.db.port,
    user: env.db.username,
    password: env.db.password,
    database: 'postgres',
  })
  await admin.connect()

  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [env.db.name])
    if (existing.rowCount && existing.rowCount > 0) {
      console.log(`database "${env.db.name}" already exists`)
    } else {
      await admin.query(`CREATE DATABASE ${quoteIdent(env.db.name)}`)
      console.log(`created database "${env.db.name}"`)
    }
  } finally {
    await admin.end()
  }

  const app = new Client({
    host: env.db.host,
    port: env.db.port,
    user: env.db.username,
    password: env.db.password,
    database: env.db.name,
  })
  await app.connect()
  await app.query('SELECT 1')
  await app.end()
  console.log(`connected to "${env.db.name}" on ${env.db.host}:${env.db.port}`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`create-db failed: ${message}`)
  process.exit(1)
})
