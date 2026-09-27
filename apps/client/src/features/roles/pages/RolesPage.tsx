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
import { CreateRoleDocument, DeleteRoleDocument, RolesDocument, UpdateRoleDocument } from '../graphql/roles.graphql'
import type { RolesQuery, RolesQueryVariables } from '@/graphql/graphql'

type Role = RolesQuery['roles']['items'][number]

interface RoleRow {
  id: string
  roleName: string
  grantCount: string
  grants: string
}

function toRow(role: Role): RoleRow {
  return {
    id: role.id,
    roleName: role.roleName,
    grantCount: String(role.permissions.length),
    grants: role.permissions.map((permission) => permission.permissionName).join(', '),
  }
}

function toVariables(state: TableState): RolesQueryVariables {
  // The roles endpoint takes no search, no sort and no filters; the screen says
  // so with `searchable={false}` and by declaring no `sortField`, and this is the
  // whole variable mapping that remains.
  return { page: state.page + 1, pageSize: state.pageSize }
}

const FIELDS: readonly FormField[] = [
  { name: 'roleName', label: 'Role name', type: 'text', required: true, maxLength: 100, autoComplete: 'off' },
]

const COLUMNS: readonly DataTableColumn<RoleRow>[] = [
  { field: 'roleName', headerName: 'Role', width: 200 },
  { field: 'grantCount', headerName: 'Permissions', width: 130, align: 'right' },
  { field: 'grants', headerName: 'Grants', flex: 1, minWidth: 260 },
]

export function RolesPage(): React.ReactElement {
  const canWrite = usePermission('role:write')

  const [state, setState] = useState<TableState>(INITIAL_TABLE_STATE)
  const [editing, setEditing] = useState<RoleRow | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [deleting, setDeleting] = useState<RoleRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)

  const { data, loading, error, refetch } = useQuery(RolesDocument, {
    variables: toVariables(state),
    notifyOnNetworkStatusChange: true,
  })
  const [createRole, createState] = useMutation(CreateRoleDocument)
  const [updateRole, updateState] = useMutation(UpdateRoleDocument)
  const [deleteRole, deleteState] = useMutation(DeleteRoleDocument)

  const busy = createState.loading || updateState.loading || deleteState.loading
  const parsed = parseServerError(createState.error ?? updateState.error)
  const rows = (data?.roles.items ?? []).map(toRow)

  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  const submit = async (values: FormValues): Promise<void> => {
    if (editing === null) {
      await createRole({ variables: { input: { roleName: textValue(values, 'roleName') } } })
      setNotice('Role created. Assign it from the employee screen.')
    } else {
      await updateRole({
        variables: { input: { id: editing.id, roleName: textValue(values, 'roleName') } },
      })
      setNotice('Role renamed.')
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
      await deleteRole({ variables: { id: deleting.id } })
    } catch (error) {
      setWriteError(writeErrorMessage(error, 'The role could not be deleted.'))
      return
    }
    setDeleting(null)
    setNotice('Role deleted.')
    await refetch()
  }

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
        Roles
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
        totalCount={data?.roles.total ?? 0}
        state={state}
        onStateChange={setState}
        loading={loading}
        searchable={false}
        emptyMessage="No roles yet"
        toolbar={
          canWrite ? (
            <Button
              variant="contained"
              data-testid="new-role"
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              New role
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
                    Rename
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
          title={editing === null ? 'New role' : 'Rename role'}
          fields={FIELDS}
          initialValues={editing === null ? {} : { roleName: editing.roleName }}
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
          title="Delete role"
          message={`Delete ${deleting.roleName}? Employees holding it lose those permissions immediately.`}
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
