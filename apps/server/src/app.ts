import express, { type Request, type Response } from 'express'
import type { DataSource } from 'typeorm'

export function createApp(dataSource: DataSource): express.Express {
  const app = express()

  app.get('/health', async (_req: Request, res: Response) => {
    const startedAt = Date.now()
    if (!dataSource.isInitialized) {
      res.status(503).json({
        status: 'error',
        database: { connected: false, error: 'DataSource is not initialized' },
      })
      return
    }
    try {
      await dataSource.query('SELECT 1')
      res.json({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        database: {
          connected: true,
          name: dataSource.options.database,
          latencyMs: Date.now() - startedAt,
        },
      })
    } catch (error: unknown) {
      res.status(503).json({
        status: 'error',
        database: {
          connected: false,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  })

  return app
}
