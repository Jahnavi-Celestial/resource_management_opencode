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
import { formatDateTime } from '@/lib/format'
import {
  AssignEmployeeRoleDocument,
  CreateEmployeeDocument,
  DeleteEmployeeDocument,
  EmployeesDocument,
  EmployeeRolesDocument,
  RemoveEmployeeRoleDocument,
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
  /** The ids behind `roles`, which the edit dialog diffs its selection against. */
  roleIds: string[]
  createdAt: string
}

function toRow(employee: Employee): EmployeeRow {
  return {
    id: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    email: employee.email,
    roles: employee.roles.map((role) => role.roleName).join(', '),
    roleIds: employee.roles.map((role) => role.id),
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

function createFields(roleOptions: readonly FormFieldOption[]): FormField[] {
  return [
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
    { name: 'roleId', label: 'Role', type: 'select', required: true, options: roleOptions },
  ]
}

/**
 * The edit dialog's fields: the same name/email fields as create, minus the
 * password (an edit never re-sets it) and the single `roleId` (create is
 * single-choice by design), plus the roles multi-select.
 *
 * The roles field is offered only to a session holding `role:assign`. Writing
 * roles is a different permission from writing the employee record, so a
 * session with `employee:write` but not `role:assign` gets a form that cannot
 * touch roles at all — the server would refuse every such call anyway (NFR-5).
 */
function editFields(roleOptions: readonly FormFieldOption[], canAssignRoles: boolean): FormField[] {
  const fields = createFields([]).filter(
    (field) => field.name !== 'password' && field.name !== 'roleId',
  )
  if (!canAssignRoles) {
    return fields
  }
  return [
    ...fields,
    {
      name: 'roles',
      label: 'Roles',
      type: 'multiselect',
      required: true,
      options: roleOptions,
      // There is no primary/secondary hierarchy: the server unions the
      // permissions of every role an employee holds, so this is the one field
      // where the consequence of a selection is a permission change.
      helperText: 'Permissions from all selected roles are combined.',
    },
  ]
}

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
  // A separate permission from `employee:write`: assigning a role is an RBAC
  // change, not an employee-record change, and the server gates the two
  // mutations on it. NFR-5: this only decides what the form offers.
  const canAssignRoles = usePermission('role:assign')

  // The dropdown offers every role in the system; the seeded Employee role is
  // the default for a new account. Skipped for a session that cannot write
  // employees — it has no form to populate (NFR-5).
  const rolesQuery = useQuery(EmployeeRolesDocument, {
    variables: { page: 1, pageSize: 100 },
    skip: !canWrite,
  })
  const roleOptions: FormFieldOption[] = (rolesQuery.data?.roles.items ?? []).map((role) => ({
    value: role.id,
    label: role.roleName,
  }))
  const defaultRoleId = roleOptions.find((option) => option.label === 'Employee')?.value ?? ''

  const [state, setState] = useState<TableState>(INITIAL_TABLE_STATE)
  const [editing, setEditing] = useState<EmployeeRow | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [deleting, setDeleting] = useState<EmployeeRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  // A refusal from one of the two role mutations. It is a form-level message,
  // not a field one: the server's lockout guard names no input, and the dialog
  // must stay open so the user can retry.
  const [roleError, setRoleError] = useState<string | null>(null)

  const { data, loading, error, refetch } = useQuery(EmployeesDocument, {
    variables: toVariables(state),
    notifyOnNetworkStatusChange: true,
  })
  const [createEmployee, createState] = useMutation(CreateEmployeeDocument)
  const [updateEmployee, updateState] = useMutation(UpdateEmployeeDocument)
  const [deleteEmployee, deleteState] = useMutation(DeleteEmployeeDocument)
  const [assignRole, assignState] = useMutation(AssignEmployeeRoleDocument)
  const [removeRole, removeState] = useMutation(RemoveEmployeeRoleDocument)

  const busy =
    createState.loading ||
    updateState.loading ||
    deleteState.loading ||
    assignState.loading ||
    removeState.loading
  const parsed = parseServerError(createState.error ?? updateState.error)
  const rows = (data?.employees.items ?? []).map(toRow)

  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  /**
   * Applies the edit dialog's role selection as a diff rather than a
   * replacement: the server's two mutations are per-role, so a two-role edit is
   * one assign and one remove.
   *
   * Adds go first. If a later remove is refused — the lockout guard refuses to
   * strip the last `role:assign` holder — the employee is left holding the
   * roles they had plus the ones they should have, which is the safe direction:
   * a failure here must never take access away.
   *
   * `editing.roleIds` is advanced after every successful call, so a retry sends
   * exactly the difference still outstanding instead of re-issuing calls the
   * server has already answered (a duplicate assign is a `ConflictError`).
   */
  const applyRoleChanges = async (
    employeeId: string,
    from: readonly string[],
    to: readonly string[],
  ): Promise<void> => {
    const toAdd = to.filter((roleId) => !from.includes(roleId))
    const toRemove = from.filter((roleId) => !to.includes(roleId))
    for (const roleId of toAdd) {
      await assignRole({ variables: { input: { employeeId, roleId } } })
      setEditing((previous) =>
        previous === null ? previous : { ...previous, roleIds: [...previous.roleIds, roleId] },
      )
    }
    for (const roleId of toRemove) {
      await removeRole({ variables: { input: { employeeId, roleId } } })
      setEditing((previous) =>
        previous === null
          ? previous
          : { ...previous, roleIds: previous.roleIds.filter((id) => id !== roleId) },
      )
    }
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
            roleId: textValue(values, 'roleId'),
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
      try {
        await applyRoleChanges(editing.id, editing.roleIds, stringListValue(values, 'roles'))
      } catch (error) {
        // The name/email write already landed; only the roles are unsettled.
        // Keep the dialog open on the server's own message so the user can
        // retry, and do not re-read the list: nothing about it changed.
        setRoleError(writeErrorMessage(error, 'The roles could not be changed.'))
        return
      }
      setRoleError(null)
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
                setRoleError(null)
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
                      setRoleError(null)
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
          fields={editing === null ? createFields(roleOptions) : editFields(roleOptions, canAssignRoles)}
          initialValues={
            editing === null
              ? { roleId: defaultRoleId }
              : {
                  firstName: editing.firstName,
                  lastName: editing.lastName,
                  email: editing.email,
                  // The roles the employee already holds, so the multi-select
                  // opens on the current state and the save is a diff.
                  roles: editing.roleIds,
                }
          }
          // NFR-6: the server's per-field messages arrive here and are rendered
          // under the input they name — a duplicate email shows on the email
          // field, not in a banner. A role refusal is form-level instead, and
          // is shown only when there is no field-level message to show.
          errors={parsed.fieldErrors}
          formError={formLevelError(parsed) ?? roleError}
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
