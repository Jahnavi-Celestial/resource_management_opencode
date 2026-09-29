import { useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Notice } from '@/components/Notice'
import { DataTable } from '@/components/DataTable'
import { INITIAL_TABLE_STATE, type DataTableColumn, type TableState } from '@/components/DataTable/types'
import { Form } from '@/components/Form'
import type { FormField, FormFieldOption, FormValues } from '@/components/Form/types'
import { stringListValue, textValue } from '@/components/Form/values'
import { usePermission } from '@/auth/usePermission'
import { formLevelError, parseServerError, writeErrorMessage } from '@/lib/fieldErrors'
import {
  AssignPermissionToRoleDocument,
  CreateRoleDocument,
  DeleteRoleDocument,
  PermissionsDocument,
  RemovePermissionFromRoleDocument,
  RolesDocument,
  UpdateRoleDocument,
} from '../graphql/roles.graphql'
import type { RolesQuery, RolesQueryVariables } from '@/graphql/graphql'

type Role = RolesQuery['roles']['items'][number]

interface RoleRow {
  id: string
  roleName: string
  isSystemRole: boolean
  grantCount: string
  grants: string
  permissionIds: string[]
}

function toRow(role: Role): RoleRow {
  return {
    id: role.id,
    roleName: role.roleName,
    isSystemRole: role.isSystemRole,
    grantCount: String(role.permissions.length),
    grants: role.permissions.map((permission) => permission.permissionName).join(', '),
    permissionIds: role.permissions.map((permission) => permission.id),
  }
}

function toVariables(state: TableState): RolesQueryVariables {
  // The roles endpoint takes no search, no sort and no filters; the screen says
  // so with `searchable={false}` and by declaring no `sortField`, and this is
  // the whole variable mapping that remains.
  return { page: state.page + 1, pageSize: state.pageSize }
}

/**
 * The permissions picker is offered only to a session that can *read* the
 * catalogue (`permission:read`, which gates the query below). The form itself
 * is already gated on `role:write`, and the two diff mutations
 * (`assignPermissionToRole`/`removePermissionFromRole`) are gated on `role:write`
 * too — writing a role's grants is part of writing the role, unlike
 * `assignRoleToEmployee` which is `role:assign`. NFR-5: this only decides what
 * to *offer*; the server re-checks every call.
 */
function formFields(
  permissionOptions: readonly FormFieldOption[],
  canAssignPermissions: boolean,
  isSystemRole: boolean,
): FormField[] {
  const fields: FormField[] = [
    {
      name: 'roleName',
      label: 'Role name',
      type: 'text',
      required: true,
      maxLength: 100,
      autoComplete: 'off',
      disabled: isSystemRole,
      helperText: isSystemRole ? 'System role — the name cannot be changed.' : undefined,
    },
  ]
  if (!canAssignPermissions) {
    return fields
  }
  return [
    ...fields,
    {
      name: 'permissions',
      label: 'Permissions',
      type: 'multiselect',
      options: permissionOptions,
      helperText: 'The permissions this role grants to every employee who holds it.',
    },
  ]
}

const COLUMNS: readonly DataTableColumn<RoleRow>[] = [
  { field: 'roleName', headerName: 'Role', width: 200 },
  { field: 'grantCount', headerName: 'Permissions', width: 130, align: 'right' },
  { field: 'grants', headerName: 'Grants', flex: 1, minWidth: 260 },
]

export function RolesPage(): React.ReactElement {
  const canWrite = usePermission('role:write')
  const canAssignPermissions = usePermission('permission:read')

  const permissionsQuery = useQuery(PermissionsDocument, {
    variables: { page: 1, pageSize: 100 },
    skip: !canAssignPermissions,
  })
  const permissionOptions: FormFieldOption[] = (permissionsQuery.data?.permissions.items ?? []).map(
    (permission) => ({
      value: permission.id,
      label: permission.permissionName,
    }),
  )

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
  const [assignPermission, assignState] = useMutation(AssignPermissionToRoleDocument)
  const [removePermission, removeState] = useMutation(RemovePermissionFromRoleDocument)

  const busy =
    createState.loading ||
    updateState.loading ||
    deleteState.loading ||
    assignState.loading ||
    removeState.loading
  const parsed = parseServerError(
    createState.error ?? updateState.error ?? assignState.error ?? removeState.error,
  )
  const rows = (data?.roles.items ?? []).map(toRow)

  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  /**
   * Applies the edit dialog's permission selection as a diff rather than a
   * replacement: the server's two mutations are per-permission, so a two-permission
   * edit is one assign and one remove.
   *
   * Adds go first. If a later remove is refused — the lockout guard refuses to
   * strip the last `role:assign` holder — the role is left holding the
   * permissions it had plus the ones it should have, which is the safe
   * direction: a failure here must never take access away.
   *
   * `editing.permissionIds` is advanced after every successful call, so a retry
   * sends exactly the difference still outstanding instead of re-issuing calls
   * the server has already answered (a duplicate assign is a `ConflictError`).
   */
  const applyPermissionChanges = async (
    roleId: string,
    from: readonly string[],
    to: readonly string[],
  ): Promise<void> => {
    const toAdd = to.filter((permissionId) => !from.includes(permissionId))
    const toRemove = from.filter((permissionId) => !to.includes(permissionId))
    for (const permissionId of toAdd) {
      await assignPermission({ variables: { input: { roleId, permissionId } } })
      setEditing((previous) =>
        previous === null
          ? previous
          : { ...previous, permissionIds: [...previous.permissionIds, permissionId] },
      )
    }
    for (const permissionId of toRemove) {
      await removePermission({ variables: { input: { roleId, permissionId } } })
      setEditing((previous) =>
        previous === null
          ? previous
          : { ...previous, permissionIds: previous.permissionIds.filter((id) => id !== permissionId) },
      )
    }
  }

  const submit = async (values: FormValues): Promise<void> => {
    if (editing === null) {
      await createRole({
        variables: {
          input: {
            roleName: textValue(values, 'roleName'),
            permissionIds: stringListValue(values, 'permissions'),
          },
        },
      })
      setNotice('Role created.')
    } else {
      await updateRole({
        variables: { input: { id: editing.id, roleName: textValue(values, 'roleName') } },
      })
      try {
        await applyPermissionChanges(editing.id, editing.permissionIds, stringListValue(values, 'permissions'))
      } catch (error) {
        // The name write already landed; only the permissions are unsettled.
        // Keep the dialog open on the server's own message so the user can
        // retry, and do not re-read the list: nothing about it changed.
        setWriteError(writeErrorMessage(error, 'The permissions could not be changed.'))
        return
      }
      setWriteError(null)
      setNotice('Role updated.')
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
        <Notice severity="success" onClose={() => setNotice(null)} resetKey={notice} testid="screen-notice">
          {notice}
        </Notice>
      )}
      {writeError !== null && (
        <Notice
          severity="error"
          onClose={() => setWriteError(null)}
          resetKey={writeError}
          testid="screen-write-error"
        >
          {writeError}
        </Notice>
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
                    Edit
                  </Button>
                  {!row.isSystemRole && (
                    <Button
                      size="small"
                      color="error"
                      data-testid="row-delete"
                      onClick={() => setDeleting(row)}
                    >
                      Delete
                    </Button>
                  )}
                </Stack>
              )
            : undefined
        }
      />

      {formOpen && (
        <Form
          key={editing?.id ?? 'create'}
          title={editing === null ? 'New role' : 'Edit role'}
          fields={formFields(permissionOptions, canAssignPermissions, editing?.isSystemRole ?? false)}
          initialValues={
            editing === null
              ? { roleName: '' }
              : { roleName: editing.roleName, permissions: editing.permissionIds }
          }
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
