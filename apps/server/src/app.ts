import 'reflect-metadata'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import cors from 'cors'
import express, { type Request, type Response } from 'express'
import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@apollo/server/express4'
import { printSchema } from 'graphql'
import { buildSchema } from 'type-graphql'
import type { DataSource } from 'typeorm'
import { authChecker } from './auth/auth-checker'
import { AuthResolver } from './auth/auth.resolver'
import { resolveAuthContext } from './auth/resolve-auth-context'
import { formatError } from './common/errors/format-error'
import type { GraphQLContext } from './common/graphql/context'
import { createLoaders } from './loaders'
import { EmployeeResolver } from './modules/employee/employee.resolver'
import { PermissionResolver } from './modules/rbac/permission.resolver'
import { RbacResolver } from './modules/rbac/rbac.resolver'
import { RoleResolver } from './modules/rbac/role.resolver'

function extractBearerToken(authorizationHeader: unknown): string | null {
  if (typeof authorizationHeader !== 'string') return null
  if (!authorizationHeader.startsWith('Bearer ')) return null
  const token = authorizationHeader.slice('Bearer '.length).trim()
  return token === '' ? null : token
}

export const SCHEMA_GRAPHQL_PATH = path.join(__dirname, '..', 'schema.graphql')

export async function createGraphQLContext(dataSource: DataSource, req: Request): Promise<GraphQLContext> {
  return {
    dataSource,
    auth: await resolveAuthContext(dataSource, extractBearerToken(req.headers.authorization)),
    loaders: createLoaders(dataSource),
  }
}

export async function createApp(dataSource: DataSource): Promise<express.Express> {
  const schema = await buildSchema({
    resolvers: [AuthResolver, RoleResolver, PermissionResolver, RbacResolver, EmployeeResolver],
    authChecker,
    validate: true,
  })
  writeFileSync(SCHEMA_GRAPHQL_PATH, printSchema(schema))

  const apollo = new ApolloServer<GraphQLContext>({ schema, formatError })
  await apollo.start()

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

  app.use(
    '/graphql',
    cors<cors.CorsRequest>(),
    express.json(),
    expressMiddleware(apollo, {
      context: async ({ req }) => createGraphQLContext(dataSource, req),
    }),
  )

  return app
}
