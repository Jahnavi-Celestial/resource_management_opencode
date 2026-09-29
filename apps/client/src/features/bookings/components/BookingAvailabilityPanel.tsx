import { useEffect, useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import LinearProgress from '@mui/material/LinearProgress'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import { usePermission } from '@/auth/usePermission'
import { localInputToIso } from '@/lib/datetimes'
import { formatDateTime } from '@/lib/format'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import {
  EquipmentAvailabilityDocument,
  RoomAvailabilityDocument,
} from '../graphql/bookings.graphql'

/**
 * FR-23 and FR-29 as the requester sees them while filling the booking form:
 * what the server already has in the chosen room over the chosen window, and how
 * much of each chosen item is still free in it.
 *
 * The whole point of this component is that it computes nothing. There is no
 * overlap rule here, no "this looks free", no subtraction of one booking from
 * another: the room's answer is `roomAvailability`'s list and the item's answer
 * is `equipmentAvailability`'s two numbers, and an empty list is rendered as the
 * server's empty answer rather than turned into a client-side verdict. A client
 * rule here would be a weaker copy of the server's FR-35 definition, evaluated
 * against a snapshot another requester can invalidate before the create lands —
 * and it would sit *beside* the server's own refusal in the same dialog, so the
 * user would be told two different things about the same slot.
 *
 * It asks per room and per item because that is the API's shape: `room:read` and
 * `equipment:read` gate the two queries separately, so a session holding one and
 * not the other is not offered the one it cannot have (NFR-5 — the server would
 * refuse it anyway; skipping the request is the courtesy, not the control).
 */

/**
 * How long the draft has to be still before the server is asked about it. The
 * same pause `DataTable` puts on its search box, for the same reason: both are
 * text fields, and a request per keystroke is a request nobody was waiting for.
 */
const AVAILABILITY_DEBOUNCE_MS = 300

export interface AvailabilityEquipmentLine {
  equipmentId: string
  quantity: number
}

export interface BookingAvailabilityPanelProps {
  /** The draft's room. Empty until the user picks one. */
  roomId: string
  /** The draft's start, as a `datetime-local` value: `YYYY-MM-DDTHH:mm`. */
  startTime: string
  /** The draft's end, same shape. */
  endTime: string
  /** The draft's equipment lines, deduplicated by item. */
  equipment: readonly AvailabilityEquipmentLine[]
  /**
   * Reports the *debounced* window the panel is asking about, so the screen
   * can show the same window-aware numbers in the equipment select's options
   * while the draft is still moving. The settled question is reported rather
   * than the immediate one: it is the question whose answer is on screen, so
   * the select never quotes a window the panel has stopped asking about.
   */
  onWindowChange?: (question: WindowQuestion) => void
}

interface AvailabilityWindow {
  startDate: string
  endDate: string
  label: string
}

/**
 * What the panel is being asked, and whether it is a question worth asking.
 *
 * The three refusals are separate states rather than one `null` because the user
 * needs to be told *which* thing is missing: "pick a room, a start and an end" is
 * wrong advice once all three are filled in and the end is simply before the start.
 * (The submit-time rule still belongs to the form's own `validateValues`; this is
 * only about when the *question* is worth asking.)
 */
export type WindowQuestion =
  | { kind: 'incomplete' }
  | { kind: 'unparseable' }
  | { kind: 'backwards' }
  | { kind: 'ready'; window: AvailabilityWindow }

const HINTS: Record<'incomplete' | 'unparseable' | 'backwards', string> = {
  incomplete: 'Pick a room, a start and an end to see what the server already has booked.',
  unparseable:
    'The start and the end have to be complete date and times before the server can be asked about them.',
  backwards: 'The end is not after the start, so there is no window to ask about yet.',
}

/** `localInputToIso`, as a question about the value rather than a throw. */
function isoOrUndefined(value: string): string | undefined {
  try {
    return localInputToIso(value)
  } catch {
    return undefined
  }
}

function windowQuestion(roomId: string, startTime: string, endTime: string): WindowQuestion {
  if (roomId === '' || startTime === '' || endTime === '') {
    return { kind: 'incomplete' }
  }
  const startDate = isoOrUndefined(startTime)
  const endDate = isoOrUndefined(endTime)
  if (startDate === undefined || endDate === undefined) {
    return { kind: 'unparseable' }
  }
  if (new Date(endDate).getTime() <= new Date(startDate).getTime()) {
    return { kind: 'backwards' }
  }
  return {
    kind: 'ready',
    window: {
      startDate,
      endDate,
      label: `${formatDateTime(startDate)} – ${formatDateTime(endDate)}`,
    },
  }
}

/**
 * Two questions are the same question when they would send the same query, which
 * is how the panel knows the debounce has caught up.
 *
 * The room is part of the key even though it is not part of `AvailabilityWindow`:
 * the room's rows are an answer about the room, so a room change with the times
 * untouched is a *different* question and must not read as settled.
 */
function questionKey(roomId: string, question: WindowQuestion): string {
  return question.kind === 'ready'
    ? `ready|${roomId}|${question.window.startDate}|${question.window.endDate}`
    : `${question.kind}|${roomId}`
}

/**
 * One room's answer to "what is already in this window".
 *
 * Rows are the server's, in the server's order, and each one is a link-shaped
 * fact rather than a client conclusion: the overlap is the server's finding, and
 * the status is whatever the server considers committed (FR-35), so a
 * CANCELLED or REJECTED booking simply does not arrive here.
 */
function RoomAvailability({
  roomId,
  window,
}: {
  roomId: string
  window: AvailabilityWindow
}): React.ReactElement {
  const { data, loading, error } = useQuery(RoomAvailabilityDocument, {
    variables: { roomId, startDate: window.startDate, endDate: window.endDate },
  })
  const bookings = data?.roomAvailability ?? []

  return (
    <Box sx={{ mt: 2 }} data-testid="availability-room">
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        Room availability
      </Typography>
      {loading && <LinearProgress data-testid="availability-room-loading" sx={{ my: 1 }} />}
      {error !== undefined && (
        <Alert severity="error" data-testid="availability-room-error" sx={{ my: 1 }}>
          {error.message}
        </Alert>
      )}
      {!loading && error === undefined && bookings.length === 0 && (
        <Typography variant="body2" color="text.secondary" data-testid="availability-room-empty">
          The server reports nothing booked in this window.
        </Typography>
      )}
      {!loading && error === undefined && bookings.length > 0 && (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} data-testid="availability-room-warning">
            {`The server already has ${String(bookings.length)} booking(s) in this window.`}
          </Typography>
          <Table size="small" data-testid="availability-room-table">
            {/* A table with three columns and no header row announces its cells
                with nothing to name them by, so the headings are part of the
                answer rather than decoration. */}
            <TableHead>
              <TableRow>
                <TableCell>Window</TableCell>
                <TableCell>Purpose</TableCell>
                <TableCell align="right">Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {bookings.map((booking) => (
                <TableRow key={booking.id} data-testid={`availability-room-row-${booking.id}`}>
                  <TableCell data-testid={`availability-room-window-${booking.id}`}>
                    {`${formatDateTime(booking.startTime)} – ${formatDateTime(booking.endTime)}`}
                  </TableCell>
                  <TableCell data-testid={`availability-room-purpose-${booking.id}`}>
                    {booking.purpose}
                  </TableCell>
                  <TableCell align="right" data-testid={`availability-room-status-${booking.id}`}>
                    <Chip size="small" label={booking.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </Box>
  )
}

/**
 * One item's answer: the standing total, what is left of it in this window, and
 * what the draft asked for.
 *
 * Its own component so its own `useQuery` — a hook cannot be called in a loop,
 * and the API takes one item per call, so a draft with three lines is three
 * queries. That is the endpoint's shape rather than an N+1 this screen chose
 * (FR-29 answers for one item; there is no batched form of it to call).
 */
function EquipmentLineAvailability({
  equipmentId,
  quantity,
  window,
}: {
  equipmentId: string
  quantity: number
  window: AvailabilityWindow
}): React.ReactElement {
  const { data, loading, error } = useQuery(EquipmentAvailabilityDocument, {
    variables: { equipmentId, startDate: window.startDate, endDate: window.endDate },
  })
  const availability = data?.equipmentAvailability
  // The one comparison this panel makes, and it is about the *draft*, not about
  // the world: the server says N are left and the draft wants M. It never
  // decides — the create still goes out, and the server's own CONFLICT is what
  // the form renders if N turns out to be stale.
  const short = availability !== undefined && availability.remainingAvailability < quantity

  return (
    <Box sx={{ mt: 2 }} data-testid={`availability-equipment-${equipmentId}`}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {availability?.name ?? 'Equipment'}
      </Typography>
      {loading && <LinearProgress data-testid={`availability-equipment-${equipmentId}-loading`} sx={{ my: 1 }} />}
      {error !== undefined && (
        <Alert severity="error" data-testid={`availability-equipment-${equipmentId}-error`} sx={{ my: 1 }}>
          {error.message}
        </Alert>
      )}
      {!loading && error === undefined && availability !== undefined && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" data-testid={`availability-equipment-${equipmentId}-remaining`}>
            {`${String(availability.remainingAvailability)} of ${String(availability.quantityAvailable)} available in this window`}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {`you asked for ${String(quantity)}`}
          </Typography>
          {short && (
            <Chip
              size="small"
              color="warning"
              data-testid={`availability-equipment-${equipmentId}-short`}
              label="Fewer than the requested quantity"
            />
          )}
        </Stack>
      )}
    </Box>
  )
}

/**
 * The panel, rendered under the booking form's fields. It is driven by the
 * draft, so it appears and disappears with the form: nothing is fetched for a
 * half-typed window, and a room change re-asks the server rather than reusing
 * the previous room's answer.
 *
 * The window is asked about *after a pause*, like the shared table's search box
 * and for the same reason: a `datetime-local` field is a text field, so typing
 * "2026-03-04" produces a run of values that are each individually parseable,
 * and without the pause every one of them would be a question to the server —
 * three equipment lines and a room per keystroke. The pause is applied to the
 * draft's primitives (the debounce cannot take an object: a fresh one every
 * render would restart its own timer forever), and while it is pending the
 * panel shows a progress bar and *nothing else* — an earlier window's rows
 * would otherwise sit under the new window's label, which is a pairing the user
 * has no way to see through.
 */
export function BookingAvailabilityPanel({
  roomId,
  startTime,
  endTime,
  equipment,
  onWindowChange,
}: BookingAvailabilityPanelProps): React.ReactElement {
  const canReadRooms = usePermission('room:read')
  const canReadEquipment = usePermission('equipment:read')

  const question = windowQuestion(roomId, startTime, endTime)
  const debouncedRoomId = useDebouncedValue(roomId, AVAILABILITY_DEBOUNCE_MS)
  const debouncedStartTime = useDebouncedValue(startTime, AVAILABILITY_DEBOUNCE_MS)
  const debouncedEndTime = useDebouncedValue(endTime, AVAILABILITY_DEBOUNCE_MS)
  // Memoized so its identity is stable while the debounced inputs are: the
  // effect below reports it upward, and a fresh object every render would be a
  // new identity every render — the parent would setState, re-render, and the
  // effect would fire again, which is the loop React's update-depth limit
  // catches.
  const settled = useMemo(
    () => windowQuestion(debouncedRoomId, debouncedStartTime, debouncedEndTime),
    [debouncedRoomId, debouncedStartTime, debouncedEndTime],
  )
  const pending = questionKey(roomId, question) !== questionKey(debouncedRoomId, settled)

  useEffect(() => {
    onWindowChange?.(settled)
  }, [settled, onWindowChange])
  // The equipment lines are keyed by item and summed, so one item asked about
  // twice is one question — and the quantities are the *draft's*, so editing a
  // quantity re-reads nothing: the server's answer for that item and window has
  // not changed, only the comparison below it has.
  const lines = new Map<string, number>()
  for (const line of equipment) {
    if (line.equipmentId === '') {
      continue
    }
    lines.set(line.equipmentId, (lines.get(line.equipmentId) ?? 0) + line.quantity)
  }

  return (
    <Paper variant="outlined" data-testid="availability-panel" sx={{ p: 2 }}>
      <Typography variant="subtitle2" component="h3" data-testid="availability-title">
        Availability
      </Typography>
      {pending ? (
        <LinearProgress data-testid="availability-pending" sx={{ my: 1 }} />
      ) : settled.kind !== 'ready' ? (
        <Typography variant="body2" color="text.secondary" data-testid="availability-hint">
          {HINTS[settled.kind]}
        </Typography>
      ) : (
        <>
          <Typography variant="caption" color="text.secondary" data-testid="availability-window">
            {settled.window.label}
          </Typography>
          {canReadRooms ? (
            <RoomAvailability roomId={debouncedRoomId} window={settled.window} />
          ) : (
            <Typography variant="body2" color="text.secondary" data-testid="availability-room-denied">
              Your account cannot read room availability.
            </Typography>
          )}
          {canReadEquipment
            ? [...lines.entries()].map(([equipmentId, quantity]) => (
                <EquipmentLineAvailability
                  key={equipmentId}
                  equipmentId={equipmentId}
                  quantity={quantity}
                  window={settled.window}
                />
              ))
            : lines.size > 0 && (
                <Typography variant="body2" color="text.secondary" data-testid="availability-equipment-denied">
                  Your account cannot read equipment availability.
                </Typography>
              )}
        </>
      )}
    </Paper>
  )
}
