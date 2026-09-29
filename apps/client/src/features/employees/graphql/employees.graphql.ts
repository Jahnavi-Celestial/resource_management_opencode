import { graphql } from '@/graphql'

/**
 * The employee list. `search`, `sort`, `page` and `pageSize` are exactly the
 * arguments the shared `DataTable` reports, so the screen's `toVariables` is a
 * one-line mapping and no filtering happens in the browser (NFR-7).
 *
 * `roles` rides along because the list shows who has what; the server resolves it
 * through the per-request loader, so a page of rows is not N queries.
 */
export const EmployeesDocument = graphql(/* GraphQL */ `
  query Employees($page: Int!, $pageSize: Int!, $search: String, $sort: SortInput) {
    employees(page: $page, pageSize: $pageSize, search: $search, sort: $sort) {
      totalCount
      items {
        id
        firstName
        lastName
        email
        createdAt
        roles {
          id
          roleName
        }
      }
    }
  }
`)

/**
 * Every role in the system, for the create form's dropdown. The role set is
 * small (seeded, rarely extended) and the form needs all of it, so one page
 * at the maximum page size is the whole table.
 */
export const EmployeeRolesDocument = graphql(/* GraphQL */ `
  query EmployeeRoles($page: Int!, $pageSize: Int!) {
    roles(page: $page, pageSize: $pageSize) {
      total
      items {
        id
        roleName
      }
    }
  }
`)

export const CreateEmployeeDocument = graphql(/* GraphQL */ `
  mutation CreateEmployee($input: CreateEmployeeInput!) {
    createEmployee(input: $input) {
      id
      email
    }
  }
`)

export const UpdateEmployeeDocument = graphql(/* GraphQL */ `
  mutation UpdateEmployee($input: UpdateEmployeeInput!) {
    updateEmployee(input: $input) {
      id
      email
    }
  }
`)

export const DeleteEmployeeDocument = graphql(/* GraphQL */ `
  mutation DeleteEmployee($id: String!) {
    deleteEmployee(id: $id)
  }
`)

/**
 * The two halves of the edit dialog's role editor. The server already exposes
 * them (`rbac.resolver.ts`, gated by `role:assign`), so the client needs no new
 * operation — only a typed document for each.
 *
 * They are separate mutations on purpose: the screen diffs the selection against
 * the roles the employee already has and applies only the difference, so a
 * two-role edit is one `assign` and one `remove` rather than a wholesale
 * replacement. The server's own lockout guard (`assertRoleRemovableFromEmployee`)
 * rides along on every `remove` for free.
 */
export const AssignEmployeeRoleDocument = graphql(/* GraphQL */ `
  mutation AssignEmployeeRole($input: EmployeeRoleInput!) {
    assignRoleToEmployee(input: $input) {
      id
    }
  }
`)

export const RemoveEmployeeRoleDocument = graphql(/* GraphQL */ `
  mutation RemoveEmployeeRole($input: EmployeeRoleInput!) {
    removeRoleFromEmployee(input: $input) {
      id
    }
  }
`)
