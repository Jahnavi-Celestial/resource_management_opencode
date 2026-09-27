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
import { textValue } from '@/components/Form/values'
import { usePermission } from '@/auth/usePermission'
import { formLevelError, parseServerError, writeErrorMessage } from '@/lib/fieldErrors'
import { formatDateTime } from '@/lib/format'
import {
  CreateEmployeeDocument,
  DeleteEmployeeDocument,
  EmployeesDocument,
  UpdateEmployeeDocument,
} from '../graphql/employees.graphql'
import type { EmployeesQuery, EmployeesQueryVariables } from '@/graphql/graphql'

type Employee = EmployeesQuery['employees']['items'][number]

interface EmployeeRow {
  id: string
  firstName: string
  lastName: string
  email: string
  roles: string
  createdAt: string
}

function toRow(employee: Employee): EmployeeRow {
  return {
    id: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    email: employee.email,
    roles: employee.roles.map((role) => role.roleName).join(', '),
    createdAt: formatDateTime(employee.createdAt),
  }
}

/**
 * The table's state → the query's variables. The 0-based page becomes the API's
 * 1-based `page`, and empty values are left out entirely so the server applies
 * its own defaults (NFR-7: nothing is filtered in the browser).
 */
function toVariables(state: TableState): EmployeesQueryVariables {
  const variables: EmployeesQueryVariables = { page: state.page + 1, pageSize: state.pageSize }
  if (state.search !== '') {
    variables.search = state.search
  }
  if (state.sort !== null) {
    variables.sort = state.sort
  }
  return variables
}

const CREATE_FIELDS: readonly FormField[] = [
  { name: 'firstName', label: 'First name', type: 'text', required: true, maxLength: 100, autoComplete: 'off' },
  { name: 'lastName', label: 'Last name', type: 'text', required: true, maxLength: 100, autoComplete: 'off' },
  { name: 'email', label: 'Email', type: 'email', required: true, maxLength: 255, autoComplete: 'off' },
  {
    name: 'password',
    label: 'Password',
    type: 'password',
    required: true,
    minLength: 8,
    maxLength: 72,
    autoComplete: 'new-password',
  },
]

const EDIT_FIELDS: readonly FormField[] = CREATE_FIELDS.filter((field) => field.name !== 'password')

const COLUMNS: readonly DataTableColumn<EmployeeRow>[] = [
  { field: 'firstName', headerName: 'First name', sortField: 'firstName', width: 160 },
  { field: 'lastName', headerName: 'Last name', sortField: 'lastName', width: 160 },
  { field: 'email', headerName: 'Email', sortField: 'email', flex: 1, minWidth: 220 },
  { field: 'roles', headerName: 'Roles', width: 200 },
  { field: 'createdAt', headerName: 'Created', sortField: 'createdAt', width: 170, align: 'right' },
]

export function EmployeesPage(): React.ReactElement {
  // NFR-5: this only decides what to *offer*. The mutations below are
  // `@Authorized('employee:write')` server-side, so a caller without the
  // permission gains nothing by calling them from the console.
  const canWrite = usePermission('employee:write')

  const [state, setState] = useState<TableState>(INITIAL_TABLE_STATE)
  const [editing, setEditing] = useState<EmployeeRow | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [deleting, setDeleting] = useState<EmployeeRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)

  const { data, loading, error, refetch } = useQuery(EmployeesDocument, {
    variables: toVariables(state),
    notifyOnNetworkStatusChange: true,
  })
  const [createEmployee, createState] = useMutation(CreateEmployeeDocument)
  const [updateEmployee, updateState] = useMutation(UpdateEmployeeDocument)
  const [deleteEmployee, deleteState] = useMutation(DeleteEmployeeDocument)

  const busy = createState.loading || updateState.loading || deleteState.loading
  const parsed = parseServerError(createState.error ?? updateState.error)
  const rows = (data?.employees.items ?? []).map(toRow)

  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  const submit = async (values: FormValues): Promise<void> => {
    if (editing === null) {
      await createEmployee({
        variables: {
          input: {
            firstName: textValue(values, 'firstName'),
            lastName: textValue(values, 'lastName'),
            email: textValue(values, 'email'),
            password: textValue(values, 'password'),
          },
        },
      })
      setNotice('Employee created.')
    } else {
      await updateEmployee({
        variables: {
          input: {
            id: editing.id,
            firstName: textValue(values, 'firstName'),
            lastName: textValue(values, 'lastName'),
            email: textValue(values, 'email'),
          },
        },
      })
      setNotice('Employee updated.')
    }
    closeForm()
    await refetch()
  }

  const confirmDelete = async (): Promise<void> => {
    if (deleting === null) {
      return
    }
    // A refusal is not a crash and it is not a success: the dialog stays open,
    // the reason is on screen, and the list is not re-read, because nothing
    // changed. Only the successful path closes and reports.
    try {
      await deleteEmployee({ variables: { id: deleting.id } })
    } catch (error) {
      setWriteError(writeErrorMessage(error, 'The employee could not be deleted.'))
      return
    }
    setDeleting(null)
    setNotice('Employee deleted.')
    await refetch()
  }

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
        Employees
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
        totalCount={data?.employees.totalCount ?? 0}
        state={state}
        onStateChange={setState}
        loading={loading}
        searchPlaceholder="Search name or email"
        emptyMessage="No employees match this search"
        toolbar={
          canWrite ? (
            <Button
              variant="contained"
              data-testid="new-employee"
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              New employee
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
                    onClick={() => setDeleting(row)}
                  >
                    Delete
                  </Button>
                </Stack>
              )
            : undefined
        }
      />

      {formOpen && (
        <Form
          key={editing?.id ?? 'create'}
          title={editing === null ? 'New employee' : 'Edit employee'}
          fields={editing === null ? CREATE_FIELDS : EDIT_FIELDS}
          initialValues={
            editing === null
              ? {}
              : { firstName: editing.firstName, lastName: editing.lastName, email: editing.email }
          }
          // NFR-6: the server's per-field messages arrive here and are rendered
          // under the input they name — a duplicate email shows on the email
          // field, not in a banner.
          errors={parsed.fieldErrors}
          formError={formLevelError(parsed)}
          submitLabel={editing === null ? 'Create' : 'Save changes'}
          submitting={busy}
          onSubmit={(values) => void submit(values)}
          onCancel={closeForm}
        />
      )}

      {deleting !== null && (
        <ConfirmDialog
          title="Delete employee"
          message={`Delete ${deleting.firstName} ${deleting.lastName}? Their booking history keeps a reference and will show as "Deleted user".`}
          confirmLabel="Delete"
          destructive
          busy={deleteState.loading}
          onConfirm={() => {
            setWriteError(null)
            void confirmDelete()
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </Box>
  )
}
