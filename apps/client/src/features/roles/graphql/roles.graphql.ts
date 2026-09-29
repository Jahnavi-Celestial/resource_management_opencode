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
        isSystemRole
        permissions {
          id
          permissionName
        }
      }
    }
  }
`)

/**
 * The whole permission catalogue, for the role form's picker. One page at the
 * maximum page size: the catalogue is a fixed 19 keys (FR-89), so this is a
 * bounded read, not an unbounded one (NFR-2). Gated on `permission:read`
 * server-side; the screen skips it for a session that lacks that.
 */
export const PermissionsDocument = graphql(/* GraphQL */ `
  query Permissions($page: Int!, $pageSize: Int!) {
    permissions(page: $page, pageSize: $pageSize) {
      total
      items {
        id
        permissionName
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

export const AssignPermissionToRoleDocument = graphql(/* GraphQL */ `
  mutation AssignPermissionToRole($input: RolePermissionInput!) {
    assignPermissionToRole(input: $input) {
      id
    }
  }
`)

export const RemovePermissionFromRoleDocument = graphql(/* GraphQL */ `
  mutation RemovePermissionFromRole($input: RolePermissionInput!) {
    removePermissionFromRole(input: $input) {
      id
    }
  }
`)
