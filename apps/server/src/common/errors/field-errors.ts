import type { ValidationError } from 'class-validator'
import { GraphQLError } from 'graphql'
import { ArgumentValidationError } from 'type-graphql'
import { DomainError } from './domain-error'

export interface FieldError {
  field: string
  message: string
}

export class InputValidationError extends DomainError {
  readonly fieldErrors: FieldError[]

  constructor(fieldErrors: FieldError[], message = 'Validation failed') {
    super(message)
    this.name = 'InputValidationError'
    this.fieldErrors = fieldErrors
  }
}

export function validationErrorsToFieldErrors(validationErrors: readonly ValidationError[]): FieldError[] {
  const fieldErrors: FieldError[] = []
  collectFieldErrors(validationErrors, '', fieldErrors)
  return fieldErrors
}

function collectFieldErrors(
  validationErrors: readonly ValidationError[],
  prefix: string,
  fieldErrors: FieldError[],
): void {
  for (const validationError of validationErrors) {
    const field = prefix === '' ? validationError.property : `${prefix}.${validationError.property}`
    const messages =
      validationError.constraints === undefined ? [] : Object.values(validationError.constraints)
    if (messages.length > 0) {
      fieldErrors.push({ field, message: messages.join(', ') })
    }
    const children = validationError.children ?? []
    if (children.length > 0) {
      collectFieldErrors(children, field, fieldErrors)
    }
  }
}

export function extractFieldErrors(error: unknown): FieldError[] | undefined {
  const candidates = error instanceof GraphQLError ? [error, error.originalError] : [error]
  for (const candidate of candidates) {
    if (candidate instanceof InputValidationError) {
      return candidate.fieldErrors
    }
    if (candidate instanceof ArgumentValidationError) {
      return validationErrorsToFieldErrors(candidate.extensions.validationErrors)
    }
  }
  return undefined
}
