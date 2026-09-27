import { useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { DataTable } from '@/components/DataTable'
import { INITIAL_TABLE_STATE, type DataTableColumn, type TableState } from '@/components/DataTable/types'
import { Form } from '@/components/Form'
import type { FormField, FormValues } from '@/components/Form/types'
import { booleanValue, numberValue, optionalTextValue, textValue } from '@/components/Form/values'
import { usePermission } from '@/auth/usePermission'
import { formLevelError, parseServerError, writeErrorMessage } from '@/lib/fieldErrors'
import { CreateRoomDocument, RoomsDocument, UpdateRoomDocument } from '../graphql/rooms.graphql'
import type { RoomsQuery, RoomsQueryVariables } from '@/graphql/graphql'

type Room = RoomsQuery['rooms']['items'][number]

interface RoomRow {
  id: string
  name: string
  location: string
  capacity: number
  isActive: string
}

function toRow(room: Room): RoomRow {
  return {
    id: room.id,
    name: room.name,
    location: room.location,
    capacity: room.capacity,
    isActive: room.isActive ? 'Yes' : 'No',
  }
}

/**
 * The filter controls here are addressed by *argument* name, which is what lets
 * the shared `DataTable` stay entity-free: `minCapacity`/`maxCapacity` on the
 * capacity column and `activeOnly` on the active column, each a server-side
 * argument the rooms endpoint really has.
 */
function toVariables(state: TableState): RoomsQueryVariables {
  const variables: RoomsQueryVariables = { page: state.page + 1, pageSize: state.pageSize }
  if (state.search !== '') {
    variables.search = state.search
  }
  if (state.sort !== null) {
    variables.sort = state.sort
  }
  const minCapacity = state.filters['minCapacity']
  if (typeof minCapacity === 'number') {
    variables.minCapacity = minCapacity
  }
  const maxCapacity = state.filters['maxCapacity']
  if (typeof maxCapacity === 'number') {
    variables.maxCapacity = maxCapacity
  }
  if (state.filters['activeOnly'] === true) {
    variables.activeOnly = true
  }
  return variables
}

const FIELDS: readonly FormField[] = [
  { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 100 },
  { name: 'location', label: 'Location', type: 'text', required: true, maxLength: 100 },
  {
    name: 'capacity',
    label: 'Capacity',
    type: 'number',
    required: true,
    min: 1,
    helperText: 'How many people fit, at least 1',
  },
  { name: 'isActive', label: 'Active (bookable)', type: 'checkbox' },
]

const COLUMNS: readonly DataTableColumn<RoomRow>[] = [
  { field: 'name', headerName: 'Name', sortField: 'name', flex: 1, minWidth: 180 },
  { field: 'location', headerName: 'Location', sortField: 'location', flex: 1, minWidth: 160 },
  {
    field: 'capacity',
    headerName: 'Capacity',
    sortField: 'capacity',
    width: 190,
    type: 'number',
    align: 'left',
    filters: [
      { key: 'minCapacity', type: 'number', label: 'Min capacity', placeholder: 'e.g. 4' },
      { key: 'maxCapacity', type: 'number', label: 'Max capacity', placeholder: 'e.g. 20' },
    ],
  },
  {
    field: 'isActive',
    headerName: 'Active',
    sortField: 'isActive',
    width: 120,
    align: 'left',
    filters: [{ key: 'activeOnly', type: 'boolean', label: 'Active only' }],
  },
]

export function RoomsPage(): React.ReactElement {
  const canWrite = usePermission('room:write')

  const [state, setState] = useState<TableState>(INITIAL_TABLE_STATE)
  const [editing, setEditing] = useState<RoomRow | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [toggling, setToggling] = useState<RoomRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)

  const { data, loading, error, refetch } = useQuery(RoomsDocument, {
    variables: toVariables(state),
    notifyOnNetworkStatusChange: true,
  })
  const [createRoom, createState] = useMutation(CreateRoomDocument)
  const [updateRoom, updateState] = useMutation(UpdateRoomDocument)
  // The API has no `deleteRoom`: a room is retired with `isActive: false`, so
  // that is what "delete" means here and what the confirm button runs.
  const [retireRoom, retireState] = useMutation(UpdateRoomDocument)

  const busy = createState.loading || updateState.loading || retireState.loading
  const parsed = parseServerError(createState.error ?? updateState.error ?? retireState.error)
  const rows = (data?.rooms.items ?? []).map(toRow)

  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  const submit = async (values: FormValues): Promise<void> => {
    if (editing === null) {
      await createRoom({
        variables: {
          input: {
            name: textValue(values, 'name'),
            location: textValue(values, 'location'),
            capacity: numberValue(values, 'capacity'),
          },
        },
      })
      setNotice('Room created.')
    } else {
      await updateRoom({
        variables: {
          input: {
            id: editing.id,
            ...(optionalTextValue(values, 'name') === undefined ? {} : { name: optionalTextValue(values, 'name') }),
            ...(optionalTextValue(values, 'location') === undefined
              ? {}
              : { location: optionalTextValue(values, 'location') }),
            ...(values['capacity'] === null ? {} : { capacity: numberValue(values, 'capacity') }),
            isActive: booleanValue(values, 'isActive'),
          },
        },
      })
      setNotice('Room updated.')
    }
    closeForm()
    await refetch()
  }

  const confirmRetire = async (): Promise<void> => {
    if (toggling === null) {
      return
    }
    // A refusal is not a crash and it is not a success: the dialog stays open,
    // the reason is on screen, and the list is not re-read, because nothing
    // changed. Only the successful path closes and reports.
    try {
      await retireRoom({ variables: { input: { id: toggling.id, isActive: false } } })
    } catch (error) {
      setWriteError(writeErrorMessage(error, 'The room could not be retired.'))
      return
    }
    setToggling(null)
    setNotice('Room retired (set to inactive).')
    await refetch()
  }

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
        Rooms
      </Typography>

      {notice !== null && (
        <Alert severity="success" onClose={() => setNotice(null)} sx={{ mb: 2 }} data-testid="screen-notice">
          {notice}
        </Alert>
      )}
      {writeError !== null && (
        <Alert
          severity="error"
          onClose={() => setWriteError(null)}
          sx={{ mb: 2 }}
          data-testid="screen-write-error"
        >
          {writeError}
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
        totalCount={data?.rooms.totalCount ?? 0}
        state={state}
        onStateChange={setState}
        loading={loading}
        searchPlaceholder="Search name or location"
        emptyMessage="No rooms match this search"
        toolbar={
          canWrite ? (
            <Button
              variant="contained"
              data-testid="new-room"
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              New room
            </Button>
          ) : null
        }
        actions={
          canWrite
            ? (row) => (
                <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
                  <Button
                    size="small"
                    data-testid="row-edit"
                    onClick={() => {
                      setEditing(row)
                      setFormOpen(true)
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    data-testid="row-delete"
                    onClick={() => setToggling(row)}
                  >
                    Retire
                  </Button>
                </Stack>
              )
            : undefined
        }
      />

      {formOpen && (
        <Form
          key={editing?.id ?? 'create'}
          title={editing === null ? 'New room' : 'Edit room'}
          fields={FIELDS}
          initialValues={editing === null ? { isActive: true } : { ...editing, isActive: editing.isActive === 'Yes' }}
          errors={parsed.fieldErrors}
          formError={formLevelError(parsed)}
          submitLabel={editing === null ? 'Create' : 'Save changes'}
          submitting={busy}
          onSubmit={(values) => void submit(values)}
          onCancel={closeForm}
        />
      )}

      {toggling !== null && (
        <ConfirmDialog
          title="Retire room"
          message={`Retire ${toggling.name}? It stays in the list and in old bookings, but can no longer be booked.`}
          confirmLabel="Retire"
          destructive
          busy={retireState.loading}
          onConfirm={() => {
            setWriteError(null)
            void confirmRetire()
          }}
          onCancel={() => setToggling(null)}
        />
      )}
    </Box>
  )
}
