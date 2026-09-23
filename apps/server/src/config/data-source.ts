import path from 'node:path'
import { DataSource } from 'typeorm'
import { loadEnv } from './env'

export function createDataSource(): DataSource {
  const env = loadEnv()
  return new DataSource({
    type: 'postgres',
    host: env.db.host,
    port: env.db.port,
    username: env.db.username,
    password: env.db.password,
    database: env.db.name,
    synchronize: false,
    entities: [],
    migrations: [path.join(__dirname, '..', 'database', 'migrations', '*.ts')],
    logging: env.nodeEnv === 'development',
  })
}
