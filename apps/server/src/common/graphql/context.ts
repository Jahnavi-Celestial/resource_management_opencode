import type { DataSource } from 'typeorm'
import type { ResolvedAuthContext } from '../../auth/resolve-auth-context'
import type { Loaders } from '../../loaders'

export interface GraphQLContext {
  dataSource: DataSource
  auth: ResolvedAuthContext | null
  loaders: Loaders
}
