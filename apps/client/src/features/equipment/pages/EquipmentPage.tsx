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
import { formatDateTime } from '@/lib/format'
import {
  CreateEquipmentDocument,
  EquipmentDocument,
  UpdateEquipmentDocument,
} from '../graphql/equipment.graphql'
import type { EquipmentQuery, EquipmentQueryVariables } from '@/graphql/graphql'

type Equipment = EquipmentQuery['equipment']['items'][number]

interface EquipmentRow {
  id: string
  name: string
  quantityAvailable: number
  isActive: string
  createdAt: string
}

function toRow(item: Equipment): EquipmentRow {
  return {
    id: item.id,
    name: item.name,
    quantityAvailable: item.quantityAvailable,
    isActive: item.isActive ? 'Yes' : 'No',
    createdAt: formatDateTime(item.createdAt),
  }
}

function toVariables(state: TableState): EquipmentQueryVariables {
  const variables: EquipmentQueryVariables = { page: state.page + 1, pageSize: state.pageSize }
  if (state.search !== '') {
    variables.search = state.search
  }
  if (state.sort !== null) {
    variables.sort = state.sort
  }
  if (state.filters['activeOnly'] === true) {
    variables.activeOnly = true
  }
  return variables
}

const FIELDS: readonly FormField[] = [
  { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 100 },
  {
    name: 'quantityAvailable',
    label: 'Quantity available',
    type: 'number',
    required: true,
    min: 0,
    helperText: 'How many are free right now, 0 or more',
  },
  { name: 'isActive', label: 'Active (bookable)', type: 'checkbox' },
]

const COLUMNS: readonly DataTableColumn<EquipmentRow>[] = [
  { field: 'name', headerName: 'Name', sortField: 'name', flex: 1, minWidth: 200 },
  { field: 'quantityAvailable', headerName: 'Available', sortField: 'quantityAvailable', width: 120, type: 'number' },
  {
    field: 'isActive',
    headerName: 'Active',
    sortField: 'isActive',
    width: 120,
    filters: [{ key: 'activeOnly', type: 'boolean', label: 'Active only' }],
  },
  { field: 'createdAt', headerName: 'Created', sortField: 'createdAt', width: 170, align: 'right' },
]

export function EquipmentPage(): React.ReactElement {
  const canWrite = usePermission('equipment:write')

  const [state, setState] = useState<TableState>(INITIAL_TABLE_STATE)
  const [editing, setEditing] = useState<EquipmentRow | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [toggling, setToggling] = useState<EquipmentRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)

  const { data, loading, error, refetch } = useQuery(EquipmentDocument, {
    variables: toVariables(state),
    notifyOnNetworkStatusChange: true,
  })
  const [createEquipment, createState] = useMutation(CreateEquipmentDocument)
  const [updateEquipment, updateState] = useMutation(UpdateEquipmentDocument)
  // No `deleteEquipment` in the API: retiring means `isActive: false`.
  const [retireEquipment, retireState] = useMutation(UpdateEquipmentDocument)

  const busy = createState.loading || updateState.loading || retireState.loading
  const parsed = parseServerError(createState.error ?? updateState.error ?? retireState.error)
  const rows = (data?.equipment.items ?? []).map(toRow)

  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  const submit = async (values: FormValues): Promise<void> => {
    if (editing === null) {
      await createEquipment({
        variables: {
          input: {
            name: textValue(values, 'name'),
            quantityAvailable: numberValue(values, 'quantityAvailable'),
          },
        },
      })
      setNotice('Equipment created.')
    } else {
      const name = optionalTextValue(values, 'name')
      await updateEquipment({
        variables: {
          input: {
            id: editing.id,
            ...(name === undefined ? {} : { name }),
            ...(values['quantityAvailable'] === null
              ? {}
              : { quantityAvailable: numberValue(values, 'quantityAvailable') }),
            isActive: booleanValue(values, 'isActive'),
          },
        },
      })
      setNotice('Equipment updated.')
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
      await retireEquipment({ variables: { input: { id: toggling.id, isActive: false } } })
    } catch (error) {
      setWriteError(writeErrorMessage(error, 'The equipment could not be retired.'))
      return
    }
    setToggling(null)
    setNotice('Equipment retired (set to inactive).')
    await refetch()
  }

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
        Equipment
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
        totalCount={data?.equipment.totalCount ?? 0}
        state={state}
        onStateChange={setState}
        loading={loading}
        searchPlaceholder="Search name"
        emptyMessage="No equipment matches this search"
        toolbar={
          canWrite ? (
            <Button
              variant="contained"
              data-testid="new-equipment"
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              New equipment
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
          title={editing === null ? 'New equipment' : 'Edit equipment'}
          fields={FIELDS}
          initialValues={
            editing === null ? { isActive: true } : { ...editing, isActive: editing.isActive === 'Yes' }
          }
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
          title="Retire equipment"
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
