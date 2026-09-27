/**
 * Turning a GraphQL error into something a `Form` can render.
 *
 * NFR-6: the server's error formatter (`apps/server/src/common/errors/
 * field-errors.ts`) turns a validation failure into
 * `extensions.fieldErrors: [{ field, message }, …]` plus
 * `extensions.code: 'BAD_USER_INPUT'`. This is the single place the client
 * unpacks that shape, so no screen re-implements it and no screen has to know
 * that the wire format is an array of `{ field, message }` rather than a map.
 */

export type FieldErrors = Record<string, string[]>

export interface ParsedServerError {
  /** Keyed by GraphQL input field name — the `name` of a `FormField`. */
  fieldErrors: FieldErrors
  /** The GraphQL error message, if there is one. */
  message: string | null
  /** `extensions.code`, e.g. `BAD_USER_INPUT`, `FORBIDDEN`, `NOT_FOUND`. */
  code: string | null
}

interface GraphQLErrorLike {
  message?: unknown
  extensions?: unknown
}

const EMPTY: ParsedServerError = { fieldErrors: {}, message: null, code: null }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Apollo Client 4 hands back a `CombinedGraphQLErrors`; AC3 and hand-rolled
 * clients hand back the array itself, and a direct `extensions` object is
 * accepted too. All three are read the same way.
 */
function errorList(error: unknown): GraphQLErrorLike[] {
  const record = asRecord(error)
  if (record === null) {
    return []
  }
  const candidates = record['errors'] ?? record['graphQLErrors']
  return Array.isArray(candidates) ? (candidates as GraphQLErrorLike[]) : [record as GraphQLErrorLike]
}

function addMessage(target: FieldErrors, field: string, message: string): void {
  const existing = target[field] ?? []
  if (!existing.includes(message)) {
    target[field] = [...existing, message]
  }
}

/** Accepts both `{ field, message }[]` (what the server sends) and a map. */
function collectFieldErrors(raw: unknown, into: FieldErrors): void {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const record = asRecord(item)
      if (record === null) continue
      const field = record['field']
      const message = record['message']
      if (typeof field === 'string' && typeof message === 'string') {
        addMessage(into, field, message)
      }
    }
    return
  }
  const map = asRecord(raw)
  if (map === null) return
  for (const [field, value] of Object.entries(map)) {
    const messages = Array.isArray(value) ? value : [value]
    for (const message of messages) {
      if (typeof message === 'string') addMessage(into, field, message)
    }
  }
}

export function parseServerError(error: unknown): ParsedServerError {
  if (error === null || error === undefined) {
    return EMPTY
  }
  const fieldErrors: FieldErrors = {}
  let message: string | null = null
  let code: string | null = null
  for (const candidate of errorList(error)) {
    const extensions = asRecord(candidate.extensions)
    if (extensions !== null) {
      if (code === null && typeof extensions['code'] === 'string') {
        code = extensions['code']
      }
      collectFieldErrors(extensions['fieldErrors'], fieldErrors)
    }
    if (message === null && typeof candidate.message === 'string' && candidate.message !== '') {
      message = candidate.message
    }
  }
  return { fieldErrors, message, code }
}

/**
 * The banner an operator sees when the refusal belongs to no single input —
 * a `FORBIDDEN` mutation, a `NOT_FOUND` id, a network failure. Anything the
 * server attributed to a field is deliberately *not* repeated here: NFR-6 wants
 * the message under the input the user has to change, not in a banner above a
 * form they have to read twice.
 */
export function formLevelError(parsed: ParsedServerError): string | null {
  return Object.keys(parsed.fieldErrors).length > 0 ? null : parsed.message
}

/**
 * A one-line message for a write with no form open — a delete, a retire. There is
 * no input to put a field error under, so its messages are joined into the
 * banner rather than dropped: on that dialog the banner is the only surface
 * there is, and silence would look like success.
 */
export function writeErrorMessage(error: unknown, fallback: string): string {
  const parsed = parseServerError(error)
  const fieldMessages = Object.values(parsed.fieldErrors).flat()
  if (parsed.message !== null) {
    return parsed.message
  }
  return fieldMessages.length > 0 ? fieldMessages.join(' ') : fallback
}
