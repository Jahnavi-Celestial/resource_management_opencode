import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import Alert from '@mui/material/Alert'
import type { FieldErrors, FormField, FormProps, FormValue, FormValues } from './types'
import { groupKey, groupRows, initialGroupValues, removeGroupRow } from './groups'

/**
 * The one form component. It is driven entirely by a field schema, so Employee,
 * Role, Room, Equipment and a booking (with its repeating equipment lines) share
 * this implementation rather than five near-copies.
 *
 * Three error sources land in the same place, deliberately:
 *   - client-side checks, so an empty required field does not cost a round trip;
 *   - the screen's cross-field rules (`validateValues`), because "end after
 *     start" belongs to no single input;
 *   - the server's `extensions.fieldErrors` from the S3 formatter, passed in as
 *     `errors` (NFR-6). A duplicate email arrives as `{ email: ['Email is
 *     already in use'] }` and is rendered under the email input, wired to it as
 *     the accessible description — not as a toast and not as a banner above a
 *     form the user has to read twice.
 *
 * The client-side rules mirror the server's for convenience only. The server
 * re-validates everything (NFR-5); nothing here is a security control.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isGroup(field: FormField): boolean {
  return field.type === 'group'
}

function initialValues(fields: readonly FormField[], provided: FormValues | undefined): FormValues {
  const values: FormValues = {}
  for (const field of fields) {
    if (isGroup(field)) {
      continue
    }
    const given = provided?.[field.name]
    if (given !== undefined) {
      values[field.name] = given
    } else if (field.type === 'checkbox') {
      values[field.name] = false
    } else {
      values[field.name] = ''
    }
  }
  // A group's rows are rendered from `rowCounts`, so their initial values are
  // addressed by composite key; `initialValues` above only covers flat fields.
  for (const field of fields) {
    if (!isGroup(field) || field.itemFields === undefined) {
      continue
    }
    const count = rowCountFor(field, provided)
    for (let index = 0; index < count; index += 1) {
      Object.assign(values, initialGroupValues(field.name, index, field.itemFields))
    }
  }
  return values
}

/** How many rows a group starts with: `minItems`, or one row per given value. */
function rowCountFor(field: FormField, provided: FormValues | undefined): number {
  if (provided === undefined) {
    return field.minItems ?? 0
  }
  const given = groupRows(provided, field.name).length
  return given > 0 ? given : (field.minItems ?? 0)
}

function addMessages(target: FieldErrors, name: string, messages: readonly string[]): void {
  const existing = target[name] ?? []
  const merged = [...existing]
  for (const message of messages) {
    if (!merged.includes(message)) {
      merged.push(message)
    }
  }
  target[name] = merged
}

function mergeErrors(base: FieldErrors, extra: FieldErrors): FieldErrors {
  const out: FieldErrors = { ...base }
  for (const [name, messages] of Object.entries(extra)) {
    addMessages(out, name, messages)
  }
  return out
}

/** Re-keys a field's messages under a group row, so a row error is a row error. */
function prefixErrors(errors: FieldErrors, group: string, index: number): FieldErrors {
  const out: FieldErrors = {}
  for (const [name, messages] of Object.entries(errors)) {
    out[groupKey(group, index, name)] = messages
  }
  return out
}

function validate(fields: readonly FormField[], values: FormValues): FieldErrors {
  const errors: FieldErrors = {}
  const add = (name: string, message: string): void => {
    const existing = errors[name] ?? []
    if (!existing.includes(message)) {
      errors[name] = [...existing, message]
    }
  }
  for (const field of fields) {
    if (isGroup(field)) {
      continue
    }
    const value = values[field.name]
    if (field.type === 'checkbox') {
      if (field.required === true && value !== true) {
        add(field.name, `${field.label} is required`)
      }
      continue
    }
    const text = value === null || value === undefined ? '' : String(value)
    if (text.trim() === '') {
      if (field.required === true) {
        add(field.name, `${field.label} is required`)
      }
      continue
    }
    if (field.type === 'email' && !EMAIL_PATTERN.test(text.trim())) {
      add(field.name, 'Enter a valid email address')
    }
    if (field.minLength !== undefined && text.length < field.minLength) {
      add(field.name, `${field.label} must be at least ${String(field.minLength)} characters long`)
    }
    if (field.maxLength !== undefined && text.length > field.maxLength) {
      add(field.name, `${field.label} must be at most ${String(field.maxLength)} characters long`)
    }
    if (field.type === 'number') {
      const parsed = Number(text)
      if (!Number.isFinite(parsed)) {
        add(field.name, `${field.label} must be a number`)
      } else {
        if (field.min !== undefined && parsed < field.min) {
          add(field.name, `${field.label} must be at least ${String(field.min)}`)
        }
        if (field.max !== undefined && parsed > field.max) {
          add(field.name, `${field.label} must be at most ${String(field.max)}`)
        }
      }
    }
    // `datetime` needs no rule of its own here: the value is either empty or a
    // complete `YYYY-MM-DDTHH:mm` the browser itself produced, and every rule
    // that needs to *compare* it (after another time, not in the past) is
    // cross-field, so the screen supplies it through `validateValues`.
  }
  return errors
}

/**
 * Rows of every group field, validated row by row with the same per-field rules.
 * An entirely blank row is not an error — a screen can add one and change its
 * mind — but a half-filled one is, because submitting it would send nonsense.
 */
function validateGroups(
  fields: readonly FormField[],
  values: FormValues,
  rowCounts: Readonly<Record<string, number>>,
): FieldErrors {
  let errors: FieldErrors = {}
  for (const field of fields) {
    if (!isGroup(field) || field.itemFields === undefined) {
      continue
    }
    const count = rowCounts[field.name] ?? 0
    if (field.required === true && count === 0) {
      errors = mergeErrors(errors, { [field.name]: [`${field.label} is required`] })
      continue
    }
    const rows = groupRows(values, field.name)
    for (let index = 0; index < count; index += 1) {
      const row = rows[index] ?? {}
      const filled = Object.values(row).some(
        (value) => value !== null && value !== undefined && value !== '',
      )
      if (!filled) {
        continue
      }
      const rowErrors = validate(field.itemFields, row)
      if (Object.keys(rowErrors).length > 0) {
        errors = mergeErrors(errors, prefixErrors(rowErrors, field.name, index))
      }
    }
  }
  return errors
}

/**
 * Values on the way to a mutation: numbers and booleans are coerced, and an
 * empty optional input becomes `null` rather than `''` — the server's
 * `@IsOptional()` skips a null but would still reject a blank string, so
 * sending `''` for "left blank" would be a client bug the API would surface as a
 * confusing validation error.
 */
function submitValues(fields: readonly FormField[], values: FormValues): FormValues {
  const out: FormValues = {}
  for (const field of fields) {
    if (isGroup(field)) {
      // Rows are re-keyed exactly as they are stored, so the screen's
      // `listValue()` reads back what was typed, coercion included.
      const rows = groupRows(values, field.name)
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] ?? {}
        const coerced = submitValues(field.itemFields ?? [], row)
        for (const [name, value] of Object.entries(coerced)) {
          out[groupKey(field.name, index, name)] = value
        }
      }
      continue
    }
    const value = values[field.name]
    if (field.type === 'checkbox') {
      out[field.name] = value === true
      continue
    }
    if (field.type === 'number') {
      const text = value === null || value === undefined ? '' : String(value).trim()
      out[field.name] = text === '' ? null : Number(text)
      continue
    }
    if (field.staticText !== undefined) {
      continue
    }
    const text = value === null || value === undefined ? '' : String(value)
    out[field.name] = text === '' ? null : text
  }
  return out
}

function messagesFor(name: string, local: FieldErrors, server: FieldErrors): string[] {
  return [...(local[name] ?? []), ...(server[name] ?? [])]
}

export function Form({
  fields,
  initialValues: provided,
  errors = {},
  formError = null,
  title,
  submitLabel = 'Save',
  cancelLabel = 'Cancel',
  submitting = false,
  presentation = 'dialog',
  validateValues,
  renderExtra,
  onSubmit,
  onCancel,
}: FormProps): React.ReactElement {
  const [values, setValues] = useState<FormValues>(() => initialValues(fields, provided))
  const [localErrors, setLocalErrors] = useState<FieldErrors>({})
  // How many rows each `group` field currently has. Row count is component state
  // rather than a value because it is not something the user typed: it is the
  // number of "Add" presses so far.
  const [rowCounts, setRowCounts] = useState<Readonly<Record<string, number>>>(() => {
    const counts: Record<string, number> = {}
    for (const field of fields) {
      if (isGroup(field)) {
        counts[field.name] = rowCountFor(field, provided)
      }
    }
    return counts
  })

  const setValue = (name: string, value: FormValue): void => {
    setValues((previous) => ({ ...previous, [name]: value }))
  }

  const addRow = (field: FormField): void => {
    if (field.itemFields === undefined) {
      return
    }
    const index = rowCounts[field.name] ?? 0
    const limit = field.maxItems
    if (limit !== undefined && index >= limit) {
      return
    }
    const itemFields = field.itemFields ?? []
    setValues((previous) => ({ ...previous, ...initialGroupValues(field.name, index, itemFields) }))
    setRowCounts((previous) => ({ ...previous, [field.name]: index + 1 }))
  }

  const removeRow = (field: FormField, index: number): void => {
    setValues((previous) => removeGroupRow(previous, field.name, index))
    setRowCounts((previous) => ({ ...previous, [field.name]: Math.max(0, (previous[field.name] ?? 0) - 1) }))
    // A removed row's messages are stale; leaving them would show an error under
    // a row that no longer exists (or, worse, under the row that shifted up).
    setLocalErrors((previous) => {
      const next: FieldErrors = {}
      for (const [key, messages] of Object.entries(previous)) {
        if (!key.startsWith(`${field.name}.`)) {
          next[key] = messages
        }
      }
      return next
    })
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (submitting) {
      return
    }
    const nextLocal = mergeErrors(
      mergeErrors(validate(fields, values), validateGroups(fields, values, rowCounts)),
      validateValues === undefined ? {} : validateValues(values),
    )
    setLocalErrors(nextLocal)
    if (Object.keys(nextLocal).length > 0) {
      return
    }
    // `onSubmit` is *allowed* to reject. A screen's mutation rejects when the
    // server refuses the write, and the screen renders that refusal from the
    // Apollo error state it already holds — an inline field error, or one
    // form-level message. The Form owns the rejection so it cannot escape as an
    // unhandled one, and so the dialog stays open with the typed values while
    // the error is on screen: closing it would throw the user's work away.
    void Promise.resolve(onSubmit(submitValues(fields, values))).catch(() => undefined)
  }

  /**
   * `keyName` is where this field's value lives. It equals `field.name` for a
   * top-level field, and the composite `group.index.subName` for a row of a
   * `group` — which is also how the server keys a field error that belongs to a
   * nested input, so one error lookup serves both.
   */
  const renderField = (field: FormField, keyName: string = field.name): ReactNode => {
    const name = keyName
    const messages = messagesFor(name, localErrors, errors)
    const invalid = messages.length > 0
    const value = values[name] ?? ''
    const helper = invalid ? (
      <span data-testid={`field-error-${name}`}>{messages.join(' ')}</span>
    ) : field.helperText !== undefined ? (
      field.helperText
    ) : undefined
    const disabled = submitting || field.disabled === true

    if (field.staticText !== undefined) {
      return (
        <Box key={name} sx={{ mb: 2 }}>
          <Typography variant="caption" color="text.secondary">
            {field.label}
          </Typography>
          <Typography variant="body2">{field.staticText}</Typography>
        </Box>
      )
    }

    if (field.type === 'checkbox') {
      return (
        <Box key={name} data-field={name} sx={{ mb: 1 }}>
          <FormControlLabel
            control={
              <Checkbox
                checked={value === true}
                disabled={disabled}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setValue(name, event.target.checked)}
              />
            }
            label={field.label}
          />
          {helper !== undefined && (
            <Typography
              variant="caption"
              color={invalid ? 'error' : 'text.secondary'}
              component="p"
              data-testid={`field-helper-${name}`}
            >
              {helper}
            </Typography>
          )}
        </Box>
      )
    }

    // `key` is deliberately absent from this object. React only accepts it as a
    // direct JSX attribute and warns when it arrives through a spread, so each
    // call site below passes `key={name}` itself.
    const textFieldProps = {
      id: `form-field-${name}`,
      label: field.label,
      required: field.required === true,
      disabled,
      fullWidth: true,
      error: invalid,
      helperText: helper,
      'data-testid': `field-${name}`,
      onChange: (event: ChangeEvent<HTMLInputElement>): void => setValue(name, event.target.value),
    }

    if (field.type === 'select') {
      return (
        <Box key={name} data-field={name} sx={{ mb: 2 }}>
          <TextField
            key={name}
            {...textFieldProps}
            select
            value={String(value ?? '')}
            onChange={(event: ChangeEvent<{ value: unknown }>) => setValue(name, String(event.target.value))}
          >
            {field.required !== true && <MenuItem value="">—</MenuItem>}
            {(field.options ?? []).map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        </Box>
      )
    }

    const inputType =
      field.type === 'email'
        ? 'email'
        : field.type === 'password'
          ? 'password'
          : field.type === 'number'
            ? 'number'
            : field.type === 'datetime'
              ? 'datetime-local'
              : 'text'

    return (
      <Box key={name} data-field={name} sx={{ mb: 2 }}>
        <TextField
          key={name}
          {...textFieldProps}
          type={inputType}
          value={value === null || value === undefined ? '' : String(value)}
          multiline={field.type === 'textarea'}
          minRows={field.type === 'textarea' ? 3 : undefined}
          autoComplete={field.autoComplete}
          slotProps={{
            htmlInput: {
              ...(field.minLength === undefined ? {} : { minLength: field.minLength }),
              ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
              ...(field.min === undefined ? {} : { min: field.min }),
              ...(field.max === undefined ? {} : { max: field.max }),
            },
          }}
        />
      </Box>
    )
  }

  /**
   * A repeatable list of sub-fields. Its rows sit side by side so the list reads
   * as a list, and each row carries its own "Remove": removing a row renumbers
   * the ones below it (see `removeGroupRow`), so a removed row's values cannot
   * reappear under a different index.
   */
  const renderGroup = (field: FormField): ReactNode => {
    const itemFields = field.itemFields ?? []
    const count = rowCounts[field.name] ?? 0
    const rows = groupRows(values, field.name)
    const groupMessages = messagesFor(field.name, localErrors, errors)
    const canAdd = field.maxItems === undefined || count < field.maxItems
    const addDisabled = submitting || field.disabled === true

    return (
      <Box key={field.name} data-field={field.name} data-testid={`group-${field.name}`} sx={{ mb: 2 }}>
        <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>
          {field.label}
        </Typography>
        {groupMessages.length > 0 && (
          <Typography
            variant="caption"
            color="error"
            component="p"
            data-testid={`field-error-${field.name}`}
            sx={{ display: 'block', mb: 1 }}
          >
            {groupMessages.join(' ')}
          </Typography>
        )}
        {field.helperText !== undefined && (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
            {field.helperText}
          </Typography>
        )}
        {Array.from({ length: count }, (_unused, index) => (
          <Stack
            key={groupKey(field.name, index, itemFields[0]?.name ?? 'row')}
            direction="row"
            spacing={1}
            useFlexGap
            data-testid={`group-row-${field.name}-${String(index)}`}
            sx={{ mb: 1, alignItems: 'flex-start' }}
          >
            {itemFields.map((item) => (
              <Box key={item.name} sx={{ flex: item.type === 'number' ? '0 0 110px' : '1 1 180px' }}>
                {renderField(item, groupKey(field.name, index, item.name))}
              </Box>
            ))}
            <Button
              size="small"
              color="error"
              disabled={addDisabled}
              data-testid={`group-remove-${field.name}-${String(index)}`}
              onClick={() => removeRow(field, index)}
              sx={{ mt: 1 }}
            >
              Remove
            </Button>
          </Stack>
        ))}
        {canAdd && (
          <Button
            size="small"
            disabled={addDisabled}
            data-testid={`group-add-${field.name}`}
            onClick={() => addRow(field)}
          >
            {field.addLabel ?? `Add ${field.label.toLowerCase()}`}
          </Button>
        )}
      </Box>
    )
  }

  const body = (
    <>
      {formError !== null && (
        <Alert severity="error" data-testid="form-error" sx={{ mb: 2 }}>
          {formError}
        </Alert>
      )}
      {fields.map((field) => (isGroup(field) ? renderGroup(field) : renderField(field)))}
      {renderExtra?.(values)}
    </>
  )

  const actions = (
    <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end', px: 3, pb: 2, pt: 1 }}>
      {onCancel !== undefined && (
        <Button onClick={onCancel} disabled={submitting} data-testid="form-cancel">
          {cancelLabel}
        </Button>
      )}
      <Button
        type="submit"
        variant="contained"
        disabled={submitting}
        data-testid="form-submit"
      >
        {submitting ? 'Saving…' : submitLabel}
      </Button>
    </Stack>
  )

  if (presentation === 'inline') {
    return (
      <Box
        component="form"
        onSubmit={handleSubmit}
        noValidate
        data-testid="form"
        data-component="Form"
      >
        {title !== undefined && (
          <Typography variant="h5" component="h2" sx={{ mb: 2 }}>
            {title}
          </Typography>
        )}
        {body}
        {actions}
      </Box>
    )
  }

  return (
    <Dialog open maxWidth="sm" fullWidth data-testid="form-dialog">
      {title !== undefined && <DialogTitle>{title}</DialogTitle>}
      <Box component="form" onSubmit={handleSubmit} noValidate data-testid="form" data-component="Form">
        <DialogContent>{body}</DialogContent>
        {actions}
      </Box>
    </Dialog>
  )
}
