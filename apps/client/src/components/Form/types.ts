/**
 * The vocabulary of the schema-driven form. A screen hands over field
 * *definitions*; it never hands over JSX per field, which is what makes one
 * `Form` usable by four unrelated CRUD screens (and by C2's booking form).
 */

export type FormValue = string | number | boolean | null

export type FormValues = Record<string, FormValue>

/** Keyed by field name; a field may have more than one message. */
export type FieldErrors = Record<string, string[]>

export type FieldType = 'text' | 'email' | 'password' | 'number' | 'select' | 'checkbox' | 'textarea'

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
  onSubmit: (values: FormValues) => void
  onCancel?: () => void
}
