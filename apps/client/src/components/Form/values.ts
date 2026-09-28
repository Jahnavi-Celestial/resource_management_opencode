import type { FormValues } from './types'
import { groupRows } from './groups'

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

/**
 * An optional *number* read out of a **draft**, which is the one case where
 * `numberValue` is the wrong reader: while the user is still typing, the value
 * is whatever the keystrokes have produced so far (`'2'`, `''`, `'-'`), and the
 * form only coerces on submit. A screen watching its own draft — the booking
 * form's availability panel does — needs "how many, if they have said one yet",
 * and a blank or half-typed line is 0 rather than an exception.
 */
export function optionalNumberValue(values: FormValues, name: string): number | undefined {
  const text = optionalTextValue(values, name)?.trim()
  if (text === undefined || text === '') {
    return undefined
  }
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * A `group` field's rows, each keyed by its sub-field name, so the same
 * `textValue`/`numberValue` helpers read a row exactly as they read a top-level
 * field. An empty row is dropped rather than sent: a screen adds a row to try
 * something, and half-finished rows should not become a mutation argument.
 */
export function listValue(values: FormValues, name: string): FormValues[] {
  return groupRows(values, name).filter((row) =>
    Object.values(row).some((value) => value !== null && value !== undefined && value !== ''),
  )
}
