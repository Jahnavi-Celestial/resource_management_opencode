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
