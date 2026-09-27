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

/**
 * The one form component. It is driven entirely by a field schema, so Employee,
 * Role, Room and Equipment (and C2's booking form) share this implementation
 * rather than four near-copies.
 *
 * Two error sources land in the same place, deliberately:
 *   - client-side checks, so an empty required field does not cost a round trip;
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

function initialValues(fields: readonly FormField[], provided: FormValues | undefined): FormValues {
  const values: FormValues = {}
  for (const field of fields) {
    const given = provided?.[field.name]
    if (given !== undefined) {
      values[field.name] = given
    } else if (field.type === 'checkbox') {
      values[field.name] = false
    } else {
      values[field.name] = ''
    }
  }
  return values
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
  onSubmit,
  onCancel,
}: FormProps): React.ReactElement {
  const [values, setValues] = useState<FormValues>(() => initialValues(fields, provided))
  const [localErrors, setLocalErrors] = useState<FieldErrors>({})

  const setValue = (name: string, value: FormValue): void => {
    setValues((previous) => ({ ...previous, [name]: value }))
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (submitting) {
      return
    }
    const nextLocal = validate(fields, values)
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

  const renderField = (field: FormField): ReactNode => {
    const name = field.name
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

  const body = (
    <>
      {formError !== null && (
        <Alert severity="error" data-testid="form-error" sx={{ mb: 2 }}>
          {formError}
        </Alert>
      )}
      {fields.map((field) => renderField(field))}
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
