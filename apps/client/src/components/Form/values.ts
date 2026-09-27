import type { FormValues } from './types'

/**
 * Reading a submitted form.
 *
 * `Form` already coerced the values and refused to submit while a required field
 * was empty, so the `textValue`/`numberValue` throws below are unreachable
 * through the UI. They exist so a screen cannot quietly send `null` for a
 * non-null GraphQL argument (`firstName: String!`) and lose the server's own
 * validation message in the process.
 */

function present(values: FormValues, name: string): string {
  const value = values[name]
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    throw new Error(`form field "${name}" is required but was empty`)
  }
  return typeof value === 'string' ? value : String(value)
}

export function textValue(values: FormValues, name: string): string {
  return present(values, name)
}

export function numberValue(values: FormValues, name: string): number {
  const parsed = Number(present(values, name))
  if (!Number.isFinite(parsed)) {
    throw new Error(`form field "${name}" is not a number`)
  }
  return parsed
}

export function booleanValue(values: FormValues, name: string): boolean {
  return values[name] === true
}

/** An optional text input: omitted from the mutation when left blank. */
export function optionalTextValue(values: FormValues, name: string): string | undefined {
  const value = values[name]
  return value === null || value === undefined || value === '' ? undefined : String(value)
}
