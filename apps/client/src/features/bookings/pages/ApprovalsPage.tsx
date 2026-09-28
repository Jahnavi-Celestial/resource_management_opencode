import { useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { DataTable } from '@/components/DataTable'
import { INITIAL_TABLE_STATE, type DataTableColumn, type TableState } from '@/components/DataTable/types'
import { Form } from '@/components/Form'
import type { FormField, FormValues } from '@/components/Form/types'
import { textValue } from '@/components/Form/values'
import { usePermission } from '@/auth/usePermission'
import { formLevelError, parseServerError, writeErrorMessage } from '@/lib/fieldErrors'
import { formatDateTime } from '@/lib/format'
import {
  ApproveBookingDocument,
  PendingQueueDocument,
  RejectBookingDocument,
} from '../graphql/approvals.graphql'
import type { PendingQueueQuery } from '@/graphql/graphql'

type QueueBooking = PendingQueueQuery['pendingQueue']['items'][number]

interface ApprovalRow {
  id: string
  requester: string
  room: string
  startTime: string
  endTime: string
  purpose: string
  attendees: number
  status: string
  equipment: string
}

function toRow(booking: QueueBooking): ApprovalRow {
  return {
    id: booking.id,
    // The server's pre-resolved label, for the same NFR-1 reason the booking
    // list has: one loader call for the page, not one per row.
    requester: booking.requester.name,
    room: booking.room.name,
    startTime: formatDateTime(booking.startTime),
    endTime: formatDateTime(booking.endTime),
    purpose: booking.purpose,
    attendees: booking.numberOfAttendees,
    status: booking.status,
    equipment: booking.equipmentLines
      .map((line) => `${line.name} ×${String(line.requestedQuantity)}`)
      .join(', '),
  }
}

/**
 * No `sortField` on any column, and that is the point, not an omission.
 *
 * `pendingQueue` takes no `sort`, no `search` and no `filter` argument (FR-50
 * fixes the queue's contents and its order server-side, and S8's suite proves a
 * `sort` argument is a BAD_USER_INPUT error). The `DataTable` says "this column
 * is not sortable" by leaving `sortField` off, so the headers are not clickable
 * and the screen never sends an argument the endpoint does not have. The order on
 * screen is the order the server sent, page by page — re-sorting here would
 * order one page of a server-paginated set and call it the queue.
 */
const COLUMNS: readonly DataTableColumn<ApprovalRow>[] = [
  { field: 'requester', headerName: 'Requester', minWidth: 150, flex: 1 },
  { field: 'room', headerName: 'Room', minWidth: 130, flex: 1 },
  { field: 'startTime', headerName: 'Requested from', width: 175, align: 'left' },
  { field: 'endTime', headerName: 'Requested to', width: 175, align: 'left' },
  { field: 'purpose', headerName: 'Purpose', minWidth: 160, flex: 1 },
  { field: 'equipment', headerName: 'Equipment', minWidth: 140, flex: 1 },
  {
    field: 'attendees',
    headerName: 'Attendees',
    width: 110,
    align: 'right',
    type: 'number',
  },
  { field: 'status', headerName: 'Status', width: 120, align: 'left' },
]

const REJECT_FIELDS: readonly FormField[] = [
  {
    name: 'reason',
    label: 'Reason',
    type: 'textarea',
    required: true,
    helperText: 'The requester is told why, in their notification and their email.',
  },
]

interface DecisionNotice {
  bookingId: string
  status: string
  rejected: boolean
}

/**
 * The manager's decision queue (FR-50–56).
 *
 * Two permission checks, because there are two permissions. The route is guarded
 * by `booking:approve` (one nav item, one `NAV_ITEMS` entry), but approving and
 * rejecting are separately gated server-side, so each control is offered on its
 * own permission: a manager who can approve but not reject sees the queue and the
 * Approve button and no Reject button. NFR-5 is why this is a *usability*
 * affordance and not the enforcement point — the mutations are `@Authorized` and
 * refuse a caller without the permission whatever the buttons say, and the
 * acceptance suite proves both halves separately.
 */
export function ApprovalsPage(): React.ReactElement {
  const navigate = useNavigate()
  const canApprove = usePermission('booking:approve')
  const canReject = usePermission('booking:reject')

  const [state, setState] = useState<TableState>(INITIAL_TABLE_STATE)
  const [approving, setApproving] = useState<ApprovalRow | null>(null)
  const [rejecting, setRejecting] = useState<ApprovalRow | null>(null)
  const [approveFailure, setApproveFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<DecisionNotice | null>(null)

  const { data, loading, error, refetch } = useQuery(PendingQueueDocument, {
    variables: { page: state.page + 1, pageSize: state.pageSize },
    notifyOnNetworkStatusChange: true,
  })
  const [approveBooking, approveState] = useMutation(ApproveBookingDocument)
  const [rejectBooking, rejectState] = useMutation(RejectBookingDocument)
  const rejectParsed = parseServerError(rejectState.error)

  const rows = (data?.pendingQueue.items ?? []).map(toRow)

  const openApprove = (row: ApprovalRow): void => {
    setNotice(null)
    setApproveFailure(null)
    setApproving(row)
  }

  const openReject = (row: ApprovalRow): void => {
    setNotice(null)
    // A refusal from an *earlier* attempt belongs to that attempt: without this
    // the Apollo error state outlives the dialog and the next one opens showing
    // a message the user has not earned yet.
    rejectState.reset()
    setRejecting(row)
  }

  const confirmApprove = async (): Promise<void> => {
    if (approving === null) {
      return
    }
    const booking = approving
    try {
      const result = await approveBooking({ variables: { id: booking.id } })
      setApproving(null)
      setApproveFailure(null)
      setNotice({
        bookingId: result.data?.approveBooking.id ?? booking.id,
        // The status the *server* wrote, not the word "APPROVED" this screen
        // hoped for: the mutation is the only thing that knows the outcome.
        status: result.data?.approveBooking.status ?? '',
        rejected: false,
      })
      await refetch()
    } catch (failure: unknown) {
      // FR-56 lands here: a manager who tries to decide their own request gets
      // the server's refusal in the dialog they are looking at.
      setApproveFailure(writeErrorMessage(failure, 'The booking could not be approved.'))
    }
  }

  const submitReject = async (values: FormValues): Promise<void> => {
    if (rejecting === null) {
      return
    }
    const booking = rejecting
    // No catch: the `Form` keeps itself open and renders the refusal from
    // `rejectState.error` — inline under the reason for FR-54's field error, as
    // a form-level alert for a refusal with no field (FR-56, a stale status).
    // The reason's *minimum length* is the server's (`REJECTION_REASON_MIN_LENGTH`),
    // so the field is `required` and nothing more: a client `minLength` would
    // keep a short reason off the wire and the user would never read the
    // message the server actually sends.
    const result = await rejectBooking({
      variables: { input: { id: booking.id, reason: textValue(values, 'reason') } },
    })
    setRejecting(null)
    setNotice({
      bookingId: result.data?.rejectBooking.id ?? booking.id,
      status: result.data?.rejectBooking.status ?? '',
      rejected: true,
    })
    await refetch()
  }

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ mb: 1 }}>
        Booking approvals
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Every request waiting for a decision, oldest first. Open one to see its
        history, the room, and the equipment still available for that window.
      </Typography>

      {notice !== null && (
        <Alert
          severity="success"
          onClose={() => setNotice(null)}
          sx={{ mb: 2 }}
          data-testid="approval-notice"
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="body2">
              {notice.rejected ? 'Booking rejected.' : 'Booking approved.'}
            </Typography>
            <Chip
              size="small"
              label={notice.status}
              data-testid="approval-notice-status"
            />
            <Typography
              variant="caption"
              sx={{ fontFamily: 'monospace' }}
              data-testid="approval-notice-id"
            >
              {notice.bookingId}
            </Typography>
            <Link
              component="button"
              type="button"
              variant="body2"
              onClick={() => void navigate(`/bookings/${notice.bookingId}`)}
            >
              Open booking
            </Link>
          </Stack>
        </Alert>
      )}

      {error !== undefined && (
        <Alert severity="error" sx={{ mb: 2 }} data-testid="screen-error">
          {error.message}
        </Alert>
      )}

      <DataTable
        rows={rows}
        columns={COLUMNS}
        totalCount={data?.pendingQueue.totalCount ?? 0}
        state={state}
        onStateChange={setState}
        loading={loading}
        searchable={false}
        emptyMessage="No bookings are waiting for a decision"
        onRowClick={(row) => void navigate(`/bookings/${row.id}`)}
        actions={(row) => (
          <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
            {canApprove ? (
              <Button
                size="small"
                data-testid="row-approve"
                // A row click opens the detail view, and a cell's button click
                // would be one too; this keeps the two actions apart.
                onClick={(event) => {
                  event.stopPropagation()
                  openApprove(row)
                }}
              >
                Approve
              </Button>
            ) : null}
            {canReject ? (
              <Button
                size="small"
                color="error"
                data-testid="row-reject"
                onClick={(event) => {
                  event.stopPropagation()
                  openReject(row)
                }}
              >
                Reject
              </Button>
            ) : null}
          </Stack>
        )}
      />

      {approving !== null && (
        <ConfirmDialog
          title="Approve booking"
          message={`Approve ${approving.requester}'s request for ${approving.room}, ${approving.startTime} to ${approving.endTime}? The room and equipment are re-checked as available before this takes effect.`}
          confirmLabel="Approve booking"
          busy={approveState.loading}
          error={approveFailure}
          onConfirm={() => {
            setApproveFailure(null)
            void confirmApprove()
          }}
          onCancel={() => {
            setApproving(null)
            setApproveFailure(null)
          }}
        />
      )}

      {rejecting !== null && (
        <Form
          key={`reject-${rejecting.id}`}
          title="Reject booking"
          fields={REJECT_FIELDS}
          errors={rejectParsed.fieldErrors}
          formError={formLevelError(rejectParsed)}
          submitLabel="Reject booking"
          submitting={rejectState.loading}
          onSubmit={(values) => void submitReject(values)}
          onCancel={() => setRejecting(null)}
        />
      )}
    </Box>
  )
}
