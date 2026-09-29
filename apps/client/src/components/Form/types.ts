/**
 * The vocabulary of the schema-driven form. A screen hands over field
 * *definitions*; it never hands over JSX per field, which is what makes one
 * `Form` usable by four unrelated CRUD screens (and by C2's booking form).
 */

import type { ReactNode } from 'react'

/**
 * `string[]` exists for `multiselect` only. It is deliberately not a general
 * "any list" member: a `group` field stores its rows under flat composite keys
 * (`equipment.0.quantity`), so every value it writes is still a scalar, and
 * widening this union for a list nobody reads would make every reader below
 * guess at a shape it cannot see.
 */
export type FormValue = string | number | boolean | null | string[]

export type FormValues = Record<string, FormValue>

/** Keyed by field name; a field may have more than one message. */
export type FieldErrors = Record<string, string[]>

/**
 * `datetime` is `YYYY-MM-DDTHH:mm` — exactly what `<input type="datetime-local">`
 * holds, in the viewer's own zone. Turning that into the API's UTC RFC 3339
 * instant is the screen's job (it knows what its mutation's scalar means), not
 * the form's, which is why this is one input type rather than a date field and a
 * time field.
 *
 * `group` is a repeatable set of sub-fields: a list of things that share one
 * shape, entered any number of times (booking equipment lines, invitees). It
 * exists because a flat field schema cannot say "the same row again, with this
 * row's values", and a screen must not hand-roll that loop if the booking form
 * is to keep sharing this component.
 *
 * `multiselect` is the one field that holds several values at once: a set of
 * choices from one option list, where the answer is "which of these" rather
 * than "which one" (an employee's roles). It is a list of option values, so
 * the screen reads it with `stringListValue` — never `textValue`, which would
 * join the list into a single string.
 */
export type FieldType =
  | 'text'
  | 'email'
  | 'password'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'textarea'
  | 'datetime'
  | 'group'

export interface FormFieldOption {
  value: string
  label: string
}

export interface FormField {
  name: string
  label: string
  type: FieldType
  required?: boolean
  options?: readonly FormFieldOption[]
  helperText?: string
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  autoComplete?: string
  disabled?: boolean
  /** Rendered as read-only text instead of an input. */
  staticText?: string
  /** `group` only: the shape of one row. */
  itemFields?: readonly FormField[]
  /** `group` only: the button that adds a row. */
  addLabel?: string
  /** `group` only: rows rendered up front (0 unless the list is required). */
  minItems?: number
  /** `group` only: how many rows may be added. */
  maxItems?: number
}

export interface FormProps {
  fields: readonly FormField[]
  initialValues?: FormValues
  /**
   * Server-side field errors, keyed by field name (NFR-6). Rendered inline
   * under the input they belong to — the same way a client-side error is — so
   * the user is told which field to change.
   */
  errors?: FieldErrors
  /** A refusal that belongs to no single input (`FORBIDDEN`, `NOT_FOUND`). */
  formError?: string | null
  title?: string
  submitLabel?: string
  cancelLabel?: string
  submitting?: boolean
  /** `dialog` (default) puts the form in a `Dialog`; `inline` in a `Box`. */
  presentation?: 'dialog' | 'inline'
  /**
   * Cross-field rules, supplied by the screen because no per-field schema can
   * express them: "end after start", "start not in the past", "this field must
   * match that one". Its messages are merged with the built-in per-field ones
   * and rendered in the same place — under the input the user must change.
   *
   * A convenience only. The server re-checks all of it (NFR-5), and a client
   * rule that *prevents* the request would hide the server's own message — so
   * the booking form deliberately does not check, say, attendees against the
   * room's capacity, and lets the real refusal be shown.
   */
  validateValues?: (values: FormValues) => FieldErrors
  /**
   * A slot under the fields, given the values *as they stand* on every render.
   *
   * It exists because some of what a form should show is not a field: the
   * booking create dialog answers FR-23/29 with the room's and the equipment's
   * availability for the window the user has typed so far, and that is the
   * server's answer to a question about the draft, not one more input. The
   * alternative — a screen that re-implements the form's state to watch it — is
   * the second copy of a form this component exists to prevent.
   *
   * It must return an *element*, not call hooks: the returned component owns its
   * own state, so this is a normal child, not a callback that would run another
   * component's hooks inside the form's render.
   */
  renderExtra?: (values: FormValues) => ReactNode
  onSubmit: (values: FormValues) => void
  onCancel?: () => void
}
