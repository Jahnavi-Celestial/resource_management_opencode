import type { AuthCheckerFn } from 'type-graphql'
import { AuthorisationError } from '../common/errors/authorisation-error'
import type { GraphQLContext } from '../common/graphql/context'

export const authChecker: AuthCheckerFn<GraphQLContext> = ({ context }, requiredPermissions) => {
  if (context.auth === null) {
    throw new AuthorisationError()
  }
  if (requiredPermissions.length === 0) {
    return true
  }
  for (const requiredPermission of requiredPermissions) {
    if (!context.auth.permissionKeys.has(requiredPermission)) {
      throw new AuthorisationError()
    }
  }
  return true
}
