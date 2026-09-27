/**
 * The one display-name fallback in the client (FR-7/FR-48, §6).
 *
 * It is a deliberate twin of the server's `employeeDisplayName`
 * (`apps/server/src/loaders/employee.loader.ts`): a requester or an actor whose
 * employee row was hard-deleted is still referenced by the booking/audit
 * tables, and both the API and this helper must label that person identically.
 * C2 (booking requester) and C4 (audit actor) both go through this function
 * rather than formatting a name at each call site.
 */
export const DELETED_USER_DISPLAY_NAME = 'Deleted user'

export interface EmployeeNameFields {
  firstName: string | null | undefined
  lastName: string | null | undefined
}

/**
 * `"first last"`, or the deleted-user label when there is nothing to show.
 *
 * A partially blank record still renders the part it has: the API can return an
 * employee with an empty last name, and `Deleted user` would be a lie about a
 * person who does exist.
 */
export function displayName(employee: EmployeeNameFields | null | undefined): string {
  if (employee === null || employee === undefined) {
    return DELETED_USER_DISPLAY_NAME
  }
  const name = `${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim()
  return name === '' ? DELETED_USER_DISPLAY_NAME : name
}
