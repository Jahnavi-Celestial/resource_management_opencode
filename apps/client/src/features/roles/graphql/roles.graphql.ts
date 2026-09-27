import { graphql } from '@/graphql'

/**
 * The role list. This endpoint takes neither `search` nor `sort`, which the
 * screen states by passing `searchable={false}` and by giving no column a
 * `sortField` — the shared `DataTable` then renders a plain, inert table rather
 * than a search box that would silently do nothing.
 *
 * `permissions` comes from the batched role-permissions loader.
 */
export const RolesDocument = graphql(/* GraphQL */ `
  query Roles($page: Int!, $pageSize: Int!) {
    roles(page: $page, pageSize: $pageSize) {
      total
      items {
        id
        roleName
        permissions {
          id
          permissionName
        }
      }
    }
  }
`)

export const CreateRoleDocument = graphql(/* GraphQL */ `
  mutation CreateRole($input: CreateRoleInput!) {
    createRole(input: $input) {
      id
      roleName
    }
  }
`)

export const UpdateRoleDocument = graphql(/* GraphQL */ `
  mutation UpdateRole($input: UpdateRoleInput!) {
    updateRole(input: $input) {
      id
      roleName
    }
  }
`)

export const DeleteRoleDocument = graphql(/* GraphQL */ `
  mutation DeleteRole($id: String!) {
    deleteRole(id: $id)
  }
`)
