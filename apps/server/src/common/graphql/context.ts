import type { DataSource } from 'typeorm'
import type { ResolvedAuthContext } from '../../auth/resolve-auth-context'

export interface GraphQLContext {
  dataSource: DataSource
  auth: ResolvedAuthContext | null
}
