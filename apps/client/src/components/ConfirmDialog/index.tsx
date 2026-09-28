import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'

export interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Renders the confirm button as the error colour (a destructive action). */
  destructive?: boolean
  busy?: boolean
  /**
   * A refusal the server returned, shown *inside* the dialog.
   *
   * A confirm has no field to hang an error under, and the obvious alternative —
   * a banner on the screen behind the dialog — is not actually visible: MUI marks
   * the background `aria-hidden` while a modal is open, so the refusal would be
   * in the DOM and unreachable. The dialog therefore stays open and says why
   * here, next to the button that has to be pressed again to try.
   */
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
}

/** One confirmation dialog, shared by every destructive action in the app. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.ReactElement {
  return (
    <Dialog open maxWidth="xs" fullWidth data-testid="confirm-dialog">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText data-testid="confirm-message">{message}</DialogContentText>
        {error !== null && (
          <Alert severity="error" sx={{ mt: 2 }} data-testid="confirm-error">
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy} data-testid="confirm-cancel">
          {cancelLabel}
        </Button>
        <Button
          onClick={onConfirm}
          disabled={busy}
          variant="contained"
          color={destructive ? 'error' : 'primary'}
          data-testid="confirm-accept"
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
