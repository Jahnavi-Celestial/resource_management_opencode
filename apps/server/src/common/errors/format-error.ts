import { GraphQLError, type GraphQLFormattedError } from 'graphql'
import { AuthorisationError } from './authorisation-error'
import { ConflictError } from './conflict-error'
import { DomainError } from './domain-error'
import { InvalidCredentialsError } from './invalid-credentials-error'
import { LockoutGuardError } from './lockout-guard-error'
import { NotFoundError } from './not-found-error'

const CODE_BY_ERROR_NAME: Record<string, string> = {
  [AuthorisationError.name]: 'FORBIDDEN',
  [InvalidCredentialsError.name]: 'UNAUTHENTICATED',
  [NotFoundError.name]: 'NOT_FOUND',
  [ConflictError.name]: 'CONFLICT',
  [LockoutGuardError.name]: 'LOCKOUT_GUARD',
  [DomainError.name]: 'BAD_USER_INPUT',
}

function resolveCode(error: unknown): string | undefined {
  if (error instanceof GraphQLError) {
    const original = error.originalError
    return original instanceof Error ? CODE_BY_ERROR_NAME[original.name] : undefined
  }
  if (error instanceof Error) {
    return CODE_BY_ERROR_NAME[error.name]
  }
  return undefined
}

export function formatError(formattedError: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  const code = resolveCode(error)
  const extensions: Record<string, unknown> = { ...formattedError.extensions }
  delete extensions.stacktrace
  if (code !== undefined) {
    extensions.code = code
  }
  return { ...formattedError, extensions }
}
