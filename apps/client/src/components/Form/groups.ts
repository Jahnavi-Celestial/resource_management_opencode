import type { FormField, FormValues } from './types'

/**
 * Where a `group` field's values live inside the one flat `FormValues` map.
 *
 * A group is rendered as several rows of sub-fields, and the form still keeps a
 * *single* flat map of scalars — so a row's value is addressed by a composite
 * key, `group.index.subField` (`equipment.0.quantity`). Keeping one map rather
 * than a nested object means every existing helper (`textValue`,
 * `numberValue`, `submitValues`'s coercion) works on group rows unchanged, and a
 * server field error keyed `equipment.0.quantity` lands under exactly the input
 * that produced it.
 */

const SEPARATOR = '.'

export function groupKey(group: string, index: number, field: string): string {
  return `${group}${SEPARATOR}${String(index)}${SEPARATOR}${field}`
}

export function isGroupKey(key: string): boolean {
  return key.includes(SEPARATOR)
}

/** The defaults one new row starts with: a checkbox is false, everything else blank. */
export function blankValues(fields: readonly FormField[]): FormValues {
  const values: FormValues = {}
  for (const field of fields) {
    values[field.name] = field.type === 'checkbox' ? false : ''
  }
  return values
}

export function initialGroupValues(
  group: string,
  index: number,
  itemFields: readonly FormField[],
): FormValues {
  const values: FormValues = {}
  for (const [name, value] of Object.entries(blankValues(itemFields))) {
    values[groupKey(group, index, name)] = value
  }
  return values
}

/**
 * Drops row `index` of `group` and closes the gap, so the rows after it keep
 * contiguous indices. Without the renumbering, removing the first of two rows
 * would leave `equipment.1.*` behind with no `equipment.0.*`, and the second
 * row's values would silently reappear under a different index.
 */
export function removeGroupRow(values: FormValues, group: string, index: number): FormValues {
  const next: FormValues = {}
  for (const [key, value] of Object.entries(values)) {
    const parsed = parseGroupKey(key)
    if (parsed === null || parsed.group !== group) {
      next[key] = value
      continue
    }
    if (parsed.index === index) {
      continue
    }
    const target = parsed.index > index ? parsed.index - 1 : parsed.index
    next[groupKey(group, target, parsed.field)] = value
  }
  return next
}

export interface ParsedGroupKey {
  group: string
  index: number
  field: string
}

export function parseGroupKey(key: string): ParsedGroupKey | null {
  const parts = key.split(SEPARATOR)
  if (parts.length !== 3) {
    return null
  }
  const index = Number(parts[1])
  if (!Number.isInteger(index) || index < 0) {
    return null
  }
  return { group: parts[0] as string, index, field: parts[2] as string }
}

/** The rows of one group, each keyed by its *sub-field* name. */
export function groupRows(values: FormValues, group: string): FormValues[] {
  const rows: FormValues[] = []
  for (const [key, value] of Object.entries(values)) {
    const parsed = parseGroupKey(key)
    if (parsed === null || parsed.group !== group) {
      continue
    }
    const row = rows[parsed.index] ?? {}
    row[parsed.field] = value
    rows[parsed.index] = row
  }
  for (let index = 0; index < rows.length; index += 1) {
    rows[index] = rows[index] ?? {}
  }
  return rows
}
