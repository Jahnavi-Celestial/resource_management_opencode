import { QueryFailedError } from 'typeorm'

const UNIQUE_VIOLATION_CODE = '23505'

export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  if (!(error instanceof QueryFailedError)) return false
  const driverError = error.driverError as { code?: string; constraint?: string } | undefined
  const code = driverError?.code ?? (error as { code?: string }).code
  const constraint = driverError?.constraint ?? (error as { constraint?: string }).constraint
  return code === UNIQUE_VIOLATION_CODE && (constraintName === undefined || constraint === constraintName)
}
