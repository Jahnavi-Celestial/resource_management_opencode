import { Link as RouterLink, useParams } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import LinearProgress from '@mui/material/LinearProgress'
import Link from '@mui/material/Link'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import { useAnyPermission } from '@/auth/usePermission'
import { displayName } from '@/lib/displayName'
import { formatDateTime } from '@/lib/format'
import { BookingDetailDocument } from '../graphql/bookings.graphql'
import type { BookingDetailQuery, BookingListStatus } from '@/graphql/graphql'

type Detail = BookingDetailQuery['booking']
type Summary = Detail['requester']['recentBookings'][number]
type Transition = Detail['statusHistory'][number]
type EquipmentLine = Detail['equipmentLines'][number]

/**
 * The booking detail view (FR-45–49).
 *
 * Three decisions are worth stating up front, because each one is a rule rather
 * than a preference:
 *
 * - **Every person is labelled by `displayName()`.** The requester, the approver
 *   and each history actor go through that one function, which is C1's tested
 *   twin of the server's `employeeDisplayName`. A hard-deleted employee (FR-7)
 *   therefore renders as `Deleted user` here because the *client* decided it, not
 *   because the API handed over a finished string — the document does not even
 *   select the server's `name` for these people, precisely so that a second
 *   implementation cannot creep in at a call site.
 * - **The list stays a list, and the detail stays a detail.** This screen uses
 *   plain MUI tables, not the shared `DataTable`: those tables are not paginated
 *   server-side collections, they are the handful of rows the API resolved
 *   *with* this booking. Driving them through a `TableState` would mean inventing
 *   pagination for a list that has none, and `DataTable`'s contract is that the
 *   grid is told `rows`/`rowCount` by a query. NFR-7 is about *list screens*.
 * - **A refusal is content, not a crash.** The server decides visibility per
 *   booking (FR-45's `read:own`/`read:all` scope), and answers with the same
 *   generic `Not authorised` the list does. The screen renders that message and
 *   a way back, and renders no booking at all.
 */
export function BookingDetailPage(): React.ReactNode {
  const { id } = useParams<{ id: string }>()
  const mayRead = useAnyPermission('booking:read:own', 'booking:read:all')
  const bookingId = id ?? ''

  const { data, loading, error } = useQuery(BookingDetailDocument, {
    variables: { id: bookingId },
    // The route param is the cache key for this query, so a second visit to the
    // same booking is free; the skip keeps an empty param from asking for `""`.
    skip: bookingId === '',
    fetchPolicy: 'cache-and-network',
  })

  const booking = data?.booking

  if (error !== undefined) {
    return (
      <Paper sx={{ p: 3 }} data-testid="booking-detail-refused">
        <Typography variant="h4" component="h1" gutterBottom>
          Booking
        </Typography>
        <Alert severity="error" sx={{ mb: 2 }} data-testid="booking-detail-error">
          {error.message}
        </Alert>
        <BackLink />
      </Paper>
    )
  }

  if (booking === undefined) {
    return (
      <Paper sx={{ p: 3 }} data-testid="booking-detail-loading">
        <Typography variant="h4" component="h1" gutterBottom>
          Booking
        </Typography>
        {loading ? (
          <LinearProgress data-testid="booking-detail-progress" />
        ) : (
          <>
            <Alert severity="warning" sx={{ mb: 2 }} data-testid="booking-detail-missing">
              No booking with that id.
            </Alert>
            <BackLink />
          </>
        )}
      </Paper>
    )
  }

  const processed = booking.processedAt !== null || booking.processedBy !== null

  return (
    <Box data-testid="booking-detail" data-booking-id={booking.id}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h4" component="h1">
          Booking
        </Typography>
        <Chip
          size="small"
          label={booking.status}
          color={statusColour(booking.status)}
          data-testid="booking-detail-status"
        />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        <Box component="span" sx={{ fontFamily: 'monospace' }} data-testid="booking-detail-id">
          {booking.id}
        </Box>
      </Typography>

      {loading && <LinearProgress sx={{ mb: 2 }} data-testid="booking-detail-progress" />}

      <Stack spacing={2}>
        <RequestedCard booking={booking} />
        {processed && <ProcessedCard booking={booking} />}
        <StatusHistoryCard transitions={booking.statusHistory} />
        <RequesterCard booking={booking} />
        <RoomCard booking={booking} />
        <EquipmentCard lines={booking.equipmentLines} />
      </Stack>

      <Box sx={{ mt: 3 }}>
        <BackLink />
      </Box>
      {!mayRead && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          This session can reach this route with a read permission, but the server
          decides which individual bookings it may see.
        </Typography>
      )}
    </Box>
  )
}

function BackLink(): React.ReactElement {
  return (
    <Button component={RouterLink} to="/bookings" data-testid="booking-detail-back">
      Back to bookings
    </Button>
  )
}

function statusColour(status: BookingListStatus): 'default' | 'warning' | 'success' | 'error' | 'info' {
  switch (status) {
    case 'APPROVED':
    case 'COMPLETED':
      return 'success'
    case 'PENDING':
      return 'warning'
    case 'REJECTED':
      return 'error'
    case 'CANCELLED':
      return 'default'
    default:
      return 'info'
  }
}

/** A label/value pair. Every fact on this screen is one of these. */
function Detail({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }): React.ReactElement {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 150, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography variant="body2" data-testid={testId}>
        {children}
      </Typography>
    </Stack>
  )
}

function Section({
  title,
  testId,
  children,
}: {
  title: string
  testId: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-testid={testId}>
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
        {title}
      </Typography>
      <Divider sx={{ mb: 1.5 }} />
      {children}
    </Paper>
  )
}

/**
 * FR-45/46: what was asked for. The *requested* date and time is the window
 * itself plus when the request was made — the booking's own `created_at`, which
 * is the only "requested at" the schema has.
 */
function RequestedCard({ booking }: { booking: Detail }): React.ReactElement {
  return (
    <Section title="Requested" testId="booking-detail-requested">
      <Stack spacing={0.75}>
        <Detail label="Purpose" testId="requested-purpose">
          {booking.purpose}
        </Detail>
        <Detail label="Start" testId="requested-start">
          {formatDateTime(booking.startTime)}
        </Detail>
        <Detail label="End" testId="requested-end">
          {formatDateTime(booking.endTime)}
        </Detail>
        <Detail label="Attendees" testId="requested-attendees">
          {booking.numberOfAttendees}
        </Detail>
        <Detail label="Requested at" testId="requested-created-at">
          {formatDateTime(booking.createdAt)}
        </Detail>
      </Stack>
    </Section>
  )
}

/**
 * FR-46: the processed date and time, derived by the server from the deciding
 * audit row (§6 — there is no `processed_at` column), who decided it, and the
 * reason where there is one. Rendered only when the booking has been decided, so
 * a PENDING booking does not show a row of blanks.
 */
function ProcessedCard({ booking }: { booking: Detail }): React.ReactElement {
  const decided = booking.status === 'APPROVED' || booking.status === 'REJECTED' ? 'decided' : 'changed'
  return (
    <Section title="Processed" testId="booking-detail-processed">
      <Stack spacing={0.75}>
        <Detail label="Processed at" testId="processed-at">
          {formatDateTime(booking.processedAt)}
        </Detail>
        <Detail label={decided === 'decided' ? 'Decided by' : 'Changed by'} testId="processed-by">
          {/* The one call site: the approver/rejecter, labelled by the same
              function the requester and the history actors use. */}
          {displayName(booking.processedBy)}
        </Detail>
        {booking.rejectionReason !== null && (
          <Detail label="Rejection reason" testId="rejection-reason">
            {booking.rejectionReason}
          </Detail>
        )}
      </Stack>
    </Section>
  )
}

/**
 * FR-47 / NFR-8: every transition, oldest first, from the audit log. The server
 * orders it; this renders it. The create row has no old status, which is why the
 * arrow's left side can be empty — a booking has no prior state to name.
 */
function StatusHistoryCard({ transitions }: { transitions: readonly Transition[] }): React.ReactElement {
  return (
    <Section title="Status history" testId="status-history">
      {transitions.length === 0 ? (
        <Typography variant="body2" color="text.secondary" data-testid="status-history-empty">
          No transitions recorded.
        </Typography>
      ) : (
        <Table size="small" data-testid="status-history-table">
          <TableBody>
            {transitions.map((transition, index) => (
              <TableRow key={transition.id} data-testid={`transition-${String(index)}`}>
                <TableCell data-testid={`transition-${String(index)}-new`}>
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <Typography variant="body2" color="text.secondary" data-testid={`transition-${String(index)}-old`}>
                      {transition.oldStatus ?? '—'}
                    </Typography>
                    <Typography variant="body2" aria-hidden>
                      →
                    </Typography>
                    <Chip size="small" label={transition.newStatus} color={statusColour(transition.newStatus)} />
                  </Stack>
                </TableCell>
                <TableCell data-testid={`transition-${String(index)}-actor`}>
                  {displayName(transition.actor)}
                </TableCell>
                <TableCell align="right" data-testid={`transition-${String(index)}-at`}>
                  {formatDateTime(transition.transitionedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}

/**
 * FR-48: who asked, and what else they have asked for lately. A deleted
 * requester's *name* is the client's own fallback; their *email* is the server's
 * answer, because there is no display-name function for an address and the API
 * already substitutes the same constant (FR-48 says "in place of the name/email").
 */
function RequesterCard({ booking }: { booking: Detail }): React.ReactElement {
  return (
    <Section title="Requester" testId="requester">
      <Stack spacing={0.75}>
        <Detail label="Name" testId="requester-name">
          {displayName(booking.requester)}
        </Detail>
        <Detail label="Email" testId="requester-email">
          {booking.requester.email}
        </Detail>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, mb: 0.5 }}>
        Other recent bookings
      </Typography>
      <SummaryTable
        testId="requester-recent-bookings"
        rows={booking.requester.recentBookings}
        emptyMessage="No other bookings."
      />
    </Section>
  )
}

/** FR-49: the room's own facts, plus who else has it in this window. */
function RoomCard({ booking }: { booking: Detail }): React.ReactElement {
  return (
    <Section title="Room" testId="room">
      <Stack spacing={0.75}>
        <Detail label="Name" testId="room-name">
          {booking.room.name}
        </Detail>
        <Detail label="Location" testId="room-location">
          {booking.room.location}
        </Detail>
        <Detail label="Capacity" testId="room-capacity">
          {booking.room.capacity}
        </Detail>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, mb: 0.5 }}>
        Other bookings in this window
      </Typography>
      <SummaryTable testId="room-other-bookings" rows={booking.room.otherBookings} emptyMessage="Nothing else in this window." />
    </Section>
  )
}

/**
 * FR-49: for each requested line, what is left of that item during the booking's
 * own window. The server subtracts every *other* committed line overlapping the
 * window, which is why the number is not simply the item's stock.
 */
function EquipmentCard({ lines }: { lines: readonly EquipmentLine[] }): React.ReactElement {
  return (
    <Section title="Equipment" testId="equipment">
      {lines.length === 0 ? (
        <Typography variant="body2" color="text.secondary" data-testid="equipment-empty">
          No equipment requested.
        </Typography>
      ) : (
        <Table size="small" data-testid="equipment-table">
          <TableBody>
            {lines.map((line) => (
              <TableRow key={line.id} data-testid={`equipment-line-${line.equipmentId}`}>
                <TableCell data-testid={`equipment-name-${line.equipmentId}`}>{line.name}</TableCell>
                <TableCell align="right" data-testid={`equipment-requested-${line.equipmentId}`}>
                  ×{line.requestedQuantity} requested
                </TableCell>
                <TableCell align="right" data-testid={`equipment-remaining-${line.equipmentId}`}>
                  {line.remainingAvailability} left in this window
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}

/**
 * The two "other bookings" lists share one renderer, because they are the same
 * type and the same five columns. Each purpose links to that booking's own detail
 * route, which is also the keyboard-reachable way into a booking — the list row
 * click is a pointer shortcut, not the only route in.
 */
function SummaryTable({
  testId,
  rows,
  emptyMessage,
}: {
  testId: string
  rows: readonly Summary[]
  emptyMessage: string
}): React.ReactElement {
  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" data-testid={`${testId}-empty`}>
        {emptyMessage}
      </Typography>
    )
  }
  return (
    <Table size="small" data-testid={testId}>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} data-testid={`${testId}-row-${row.id}`}>
            <TableCell>
              <Link
                component={RouterLink}
                to={`/bookings/${row.id}`}
                underline="hover"
                data-testid={`${testId}-link-${row.id}`}
              >
                {row.purpose}
              </Link>
            </TableCell>
            <TableCell data-testid={`${testId}-window-${row.id}`}>
              {formatDateTime(row.startTime)} → {formatDateTime(row.endTime)}
            </TableCell>
            <TableCell align="right">
              <Chip size="small" label={row.status} color={statusColour(row.status)} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
