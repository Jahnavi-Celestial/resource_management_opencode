import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DELETED_USER_DISPLAY_NAME, displayName } from '@/lib/displayName'
import { REPO_ROOT } from './c1.harness'

/**
 * `displayName()` is the client-side answer to FR-7/FR-48: a booking or an audit
 * row can reference an employee who has since been deleted, and the UI must not
 * crash or print `null undefined`. C2 (booking requester) and C4 (audit actor)
 * both call this one function — that is why it is tested in isolation, and why
 * the server-parity check below exists: two different code paths labelling the
 * same person differently would be a visible bug.
 */
describe('C1 — displayName()', () => {
  it('returns "Deleted user" for a missing employee and the real name otherwise', () => {
    // No reference at all.
    expect(displayName(null)).toBe('Deleted user')
    expect(displayName(undefined)).toBe('Deleted user')

    // A reference that exists but carries no usable name (both columns blank,
    // or whitespace only) is the same situation as a deleted row.
    expect(displayName({ firstName: '', lastName: '' })).toBe('Deleted user')
    expect(displayName({ firstName: '   ', lastName: '\t' })).toBe('Deleted user')
    expect(displayName({ firstName: null, lastName: null })).toBe('Deleted user')

    // The normal case.
    expect(displayName({ firstName: 'Ada', lastName: 'Lovelace' })).toBe('Ada Lovelace')
    expect(displayName({ firstName: 'Ada', lastName: null })).toBe('Ada')
    expect(displayName({ firstName: null, lastName: 'Lovelace' })).toBe('Lovelace')

    // A missing part is not a deleted user: that person does exist.
    expect(displayName({ firstName: 'Ada', lastName: '' })).not.toBe('Deleted user')
  })

  it('uses the same label and the same rule as the server', () => {
    const loader = readFileSync(
      path.join(REPO_ROOT, 'apps', 'server', 'src', 'loaders', 'employee.loader.ts'),
      'utf8',
    )
    // The literal, and the join that trims a half-blank name.
    expect(DELETED_USER_DISPLAY_NAME).toBe('Deleted user')
    expect(loader).toContain(`export const DELETED_USER_DISPLAY_NAME = '${DELETED_USER_DISPLAY_NAME}'`)
    expect(loader).toContain('`${employee.firstName} ${employee.lastName}`.trim()')
  })
})
