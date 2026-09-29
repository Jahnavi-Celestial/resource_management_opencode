import { useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { BOOKING_STATUSES } from '@resource-booking/shared'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { DataTable } from '@/components/DataTable'
import { INITIAL_TABLE_STATE, type DataTableColumn, type TableState } from '@/components/DataTable/types'
import { Form } from '@/components/Form'
import { Notice } from '@/components/Notice'
import type { FieldErrors, FormField, FormValues } from '@/components/Form/types'
import { listValue, numberValue, optionalNumberValue, optionalTextValue, textValue } from '@/components/Form/values'
import { usePermission } from '@/auth/usePermission'
import { formLevelError, parseServerError } from '@/lib/fieldErrors'
import { endOfDayIso, localInputToIso, startOfDayIso } from '@/lib/datetimes'
import { formatDateTime } from '@/lib/format'
import { BookingAvailabilityPanel, type WindowQuestion } from '../components/BookingAvailabilityPanel'
import {
  BookableEquipmentDocument,
  BookableRoomsDocument,
  BookingsDocument,
  CreateBookingDocument,
  EquipmentAvailabilityForWindowDocument,
} from '../graphql/bookings.graphql'
import type {
  BookingFilterInput,
  BookingListStatus,
  BookingsQuery,
  BookingsQueryVariables,
  CreateBookingMutation,
} from '@/graphql/graphql'

type Booking = BookingsQuery['bookings']['items'][number]

/** The server clamps `pageSize` to 100 (NFR-2); a select cannot paginate. */
const OPTION_PAGE_SIZE = 100

interface BookingRow {
  id: string
  requester: string
  room: string
  startTime: string
  endTime: string
  purpose: string
  attendees: number
  status: BookingListStatus
  equipment: string
}

function toRow(booking: Booking): BookingRow {
  return {
    id: booking.id,
    // The server resolved this name in one loader for the whole page (NFR-1),
    // including the `Deleted user` fallback for a requester whose employee row
    // is gone (FR-7). Re-deriving it per row in JS would be the N+1 the loader
    // exists to avoid, so the list shows the server's label as it stands.
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
 * The table's state → the query's variables. The 0-based page becomes the API's
 * 1-based `page`, and the flat filter map the shared `DataTable` reports becomes
 * this endpoint's *nested* `BookingFilterInput`. The nesting is the screen's
 * job precisely because it is this endpoint's shape: the table only knows the
 * argument names.
 */
function toVariables(state: TableState): BookingsQueryVariables {
  const filter: BookingFilterInput = {}
  if (state.search !== '') {
    filter.search = state.search
  }
  const status = state.filters['status']
  if (typeof status === 'string' && status !== '') {
    filter.status = status as BookingListStatus
  }
  const startDate = state.filters['startDate']
  if (typeof startDate === 'string' && startDate !== '') {
    filter.startDate = startOfDayIso(startDate)
  }
  const endDate = state.filters['endDate']
  if (typeof endDate === 'string' && endDate !== '') {
    filter.endDate = endOfDayIso(endDate)
  }
  const variables: BookingsQueryVariables = { page: state.page + 1, pageSize: state.pageSize }
  if (Object.keys(filter).length > 0) {
    variables.filter = filter
  }
  if (state.sort !== null) {
    variables.sort = state.sort
  }
  return variables
}

/**
 * The three cross-field rules, mirroring S6's `createBooking` for fast feedback.
 * What is deliberately *not* here: attendees against the room's capacity, and
 * the room/equipment availability. Those are the checks a client cannot do
 * honestly (it is looking at a stale list, and another requester may have taken
 * the slot in the meantime), and a client rule that pre-empted them would hide
 * the server's real refusal. They go to the server, and its answer is rendered
 * in the form.
 *
 * The availability *panel* below the fields is the other half of that decision:
 * the user gets the server's answer for the window they have typed (FR-23/29),
 * and nothing stops them submitting. A warning that decided the outcome would be
 * a second, weaker version of the rule the server is about to apply, and it would
 * be the one that loses the race.
 */
function validateBookingTimes(values: FormValues): FieldErrors {
  const errors: FieldErrors = {}
  const start = typeof values['startTime'] === 'string' ? values['startTime'] : ''
  const end = typeof values['endTime'] === 'string' ? values['endTime'] : ''
  // A half-filled form is already showing "Start is required"; piling a second,
  // more confusing message on the empty field would only add noise.
  if (start === '') {
    return errors
  }
  const startMs = new Date(start).getTime()
  if (!Number.isNaN(startMs) && startMs < Date.now()) {
    errors['startTime'] = ['Start must not be in the past']
  }
  if (end !== '') {
    const endMs = new Date(end).getTime()
    if (!Number.isNaN(endMs) && endMs <= startMs) {
      errors['endTime'] = ['End must be after start']
    }
  }
  return errors
}

function bookingFields(roomOptions: readonly { value: string; label: string }[], equipmentOptions: readonly { value: string; label: string }[]): FormField[] {
  return [
    {
      name: 'roomId',
      label: 'Room',
      type: 'select',
      required: true,
      options: roomOptions,
    },
    {
      name: 'startTime',
      label: 'Start',
      type: 'datetime',
      required: true,
    },
    {
      name: 'endTime',
      label: 'End',
      type: 'datetime',
      required: true,
    },
    {
      name: 'numberOfAttendees',
      label: 'Number of attendees',
      type: 'number',
      required: true,
      min: 1,
      helperText: 'At least 1, and no more than the room seats',
    },
    {
      name: 'purpose',
      label: 'Purpose',
      type: 'textarea',
      required: true,
    },
    {
      name: 'equipment',
      label: 'Equipment',
      type: 'group',
      helperText: 'Optional. Each line is one item and how many of it you need.',
      addLabel: 'Add equipment',
      itemFields: [
        { name: 'equipmentId', label: 'Item', type: 'select', required: true, options: equipmentOptions },
        { name: 'quantity', label: 'Quantity', type: 'number', required: true, min: 1 },
      ],
    },
  ]
}

const COLUMNS: readonly DataTableColumn<BookingRow>[] = [
  { field: 'requester', headerName: 'Requester', minWidth: 150, flex: 1 },
  { field: 'room', headerName: 'Room', minWidth: 130, flex: 1 },
  {
    field: 'startTime',
    headerName: 'Start',
    sortField: 'startTime',
    width: 165,
    align: 'left',
    // The two date-range filters belong to this column because they bound the
    // start time, which is what the server filters on.
    filters: [
      { key: 'startDate', type: 'date', label: 'From' },
      { key: 'endDate', type: 'date', label: 'To' },
    ],
  },
  { field: 'endTime', headerName: 'End', sortField: 'endTime', width: 165, align: 'left' },
  { field: 'purpose', headerName: 'Purpose', sortField: 'purpose', minWidth: 160, flex: 1 },
  { field: 'equipment', headerName: 'Equipment', minWidth: 140, flex: 1 },
  {
    field: 'attendees',
    headerName: 'Attendees',
    sortField: 'numberOfAttendees',
    width: 115,
    align: 'right',
    type: 'number',
  },
  {
    field: 'status',
    headerName: 'Status',
    sortField: 'status',
    width: 130,
    align: 'left',
    filters: [
      {
        key: 'status',
        type: 'enum',
        label: 'Status',
        options: BOOKING_STATUSES.map((status) => ({ value: status, label: status })),
      },
    ],
  },
]

interface CreatedBooking {
  id: string
  status: string
  purpose: string
  roomName: string
}

export function BookingsPage(): React.ReactElement {
  const navigate = useNavigate()
  const canCreate = usePermission('booking:create')

  const [state, setState] = useState<TableState>(INITIAL_TABLE_STATE)
  const [formOpen, setFormOpen] = useState(false)
  const [created, setCreated] = useState<CreatedBooking | null>(null)
  // The window the availability panel is asking about, lifted from the panel so
  // the equipment select's options can show the same window-aware numbers.
  const [availabilityWindow, setAvailabilityWindow] = useState<WindowQuestion>({ kind: 'incomplete' })

  const { data, loading, error, refetch } = useQuery(BookingsDocument, {
    variables: toVariables(state),
    notifyOnNetworkStatusChange: true,
  })
  // Only asked for when this session may create one: an option list for a
  // create dialog nobody can open is a request nobody needs.
  const rooms = useQuery(BookableRoomsDocument, {
    variables: { pageSize: OPTION_PAGE_SIZE, activeOnly: true },
    skip: !canCreate,
  })
  const equipment = useQuery(BookableEquipmentDocument, {
    variables: { pageSize: OPTION_PAGE_SIZE, activeOnly: true },
    skip: !canCreate,
  })
  const [createBooking, createState] = useMutation(CreateBookingDocument)

  const windowReady = availabilityWindow.kind === 'ready' ? availabilityWindow.window : null
  // The window-aware remaining quantity of every bookable item, in the one
  // batched request the per-item endpoint cannot make (a select of ten options
  // is ten requests). Skipped until there is a window to ask about and the
  // form is open — an option list for a draft nobody is editing is a request
  // nobody needs.
  const availability = useQuery(EquipmentAvailabilityForWindowDocument, {
    variables: {
      equipmentIds: (equipment.data?.equipment.items ?? []).map((item) => item.id),
      startDate: windowReady?.startDate ?? '',
      endDate: windowReady?.endDate ?? '',
    },
    skip: !canCreate || !formOpen || windowReady === null,
  })

  const optionsLoading = rooms.loading || equipment.loading
  const parsed = parseServerError(createState.error)
  const rows = (data?.bookings.items ?? []).map(toRow)

  const roomOptions = (rooms.data?.rooms.items ?? []).map((room) => ({
    value: room.id,
    label: `${room.name} — ${room.location}, seats ${String(room.capacity)}`,
  }))
  // The select's label is the server's window-aware number once there is a
  // window to ask about: the same FR-35 answer the panel below the fields
  // prints, so the option the user picks and the quantity the panel warns
  // about can never disagree. Before that (and while the batched answer is
  // still in flight) it falls back to the standing total.
  const remainingById = new Map(
    (availability.data?.equipmentAvailabilityForWindow ?? []).map((row) => [row.equipmentId, row.remainingAvailability]),
  )
  const equipmentOptions = (equipment.data?.equipment.items ?? []).map((item) => {
    const remaining = windowReady !== null ? remainingById.get(item.id) : undefined
    return {
      value: item.id,
      label:
        remaining !== undefined
          ? `${item.name} — ${String(remaining)} available`
          : `${item.name} — ${String(item.quantityAvailable)} available`,
    }
  })

  const closeForm = (): void => {
    setFormOpen(false)
  }

  const submit = async (values: FormValues): Promise<void> => {
    // This rejects when the server refuses; the form keeps itself open and the
    // refusal is rendered from `createState.error` below. Nothing is caught here
    // on purpose: swallowing it would look like a successful booking.
    const equipmentLines = listValue(values, 'equipment')
    const result = await createBooking({
      variables: {
        input: {
          roomId: textValue(values, 'roomId'),
          startTime: localInputToIso(textValue(values, 'startTime')),
          endTime: localInputToIso(textValue(values, 'endTime')),
          purpose: textValue(values, 'purpose'),
          numberOfAttendees: numberValue(values, 'numberOfAttendees'),
          ...(equipmentLines.length === 0
            ? {}
            : {
                equipment: equipmentLines.map((line) => ({
                  equipmentId: textValue(line, 'equipmentId'),
                  quantity: numberValue(line, 'quantity'),
                })),
              }),
        },
      },
    })
    const booking: CreateBookingMutation['createBooking'] | undefined = result.data?.createBooking
    setCreated({
      id: booking?.id ?? '',
      // The server's own status, not a hardcoded "PENDING": FR-38 asks for the
      // created booking to be shown, and what it is shown is the API's answer.
      status: booking?.status ?? '',
      purpose: booking?.purpose ?? textValue(values, 'purpose'),
      roomName: booking?.room.name ?? '',
    })
    closeForm()
    await refetch()
  }

  const optionsError = rooms.error ?? equipment.error

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
        Bookings
      </Typography>

      {created !== null && (
        <Notice
          severity="success"
          onClose={() => setCreated(null)}
          resetKey={created.id}
          testid="booking-created"
        >
          <Typography variant="body2" sx={{ mb: 1 }}>
            Booking created. It is not booked yet — it waits for a manager.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="caption" color="text.secondary">
              Booking ID
            </Typography>
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }} data-testid="booking-created-id">
              {created.id}
            </Typography>
            <Chip size="small" label={created.status} color="warning" data-testid="booking-created-status" />
            <Typography variant="caption" color="text.secondary" data-testid="booking-created-summary">
              {created.roomName} · {created.purpose}
            </Typography>
          </Stack>
        </Notice>
      )}

      {error !== undefined && (
        <Alert severity="error" sx={{ mb: 2 }} data-testid="screen-error">
          {error.message}
        </Alert>
      )}
      {optionsError !== undefined && canCreate && (
        <Alert severity="error" sx={{ mb: 2 }} data-testid="screen-options-error">
          {optionsError.message}
        </Alert>
      )}

      <DataTable
        rows={rows}
        columns={COLUMNS}
        totalCount={data?.bookings.totalCount ?? 0}
        state={state}
        onStateChange={setState}
        loading={loading}
        searchPlaceholder="Search requester, room, equipment, purpose or status"
        emptyMessage="No bookings match this search"
        // A row is a link to its detail view. The table reports the click and
        // knows nothing about routes; the next prompt fills in what the detail
        // page shows.
        onRowClick={(row) => void navigate(`/bookings/${row.id}`)}
        toolbar={
          canCreate ? (
            <Button
              variant="contained"
              data-testid="new-booking"
              disabled={optionsLoading}
              onClick={() => setFormOpen(true)}
            >
              New booking
            </Button>
          ) : null
        }
      />

      {formOpen && (
        <Form
          key="create-booking"
          title="New booking"
          fields={bookingFields(roomOptions, equipmentOptions)}
          errors={parsed.fieldErrors}
          formError={formLevelError(parsed)}
          submitLabel="Create booking"
          submitting={createState.loading}
          validateValues={validateBookingTimes}
          // FR-23/29 while the form is still being filled: the panel asks the
          // server what is already in the chosen room, and what is left of each
          // chosen item, for the window typed so far. It reads the draft rather
          // than a copy of it, so there is no second set of form state to keep
          // in step.
          renderExtra={(values) => (
            <BookingAvailabilityPanel
              roomId={optionalTextValue(values, 'roomId') ?? ''}
              startTime={optionalTextValue(values, 'startTime') ?? ''}
              endTime={optionalTextValue(values, 'endTime') ?? ''}
              equipment={listValue(values, 'equipment').map((line) => ({
                equipmentId: optionalTextValue(line, 'equipmentId') ?? '',
                quantity: optionalNumberValue(line, 'quantity') ?? 0,
              }))}
              onWindowChange={setAvailabilityWindow}
            />
          )}
          onSubmit={(values) => void submit(values)}
          onCancel={closeForm}
        />
      )}
    </Box>
  )
}
