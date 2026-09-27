import { graphql } from '@/graphql'

/**
 * The session query. `permissionKeys` is the server's live, per-request
 * permission set (NFR-5: it is read from the DB on every request, so a
 * revocation takes effect on the next `me` — the client never caches a
 * permission list of its own). Roles come along because the nav shows them and
 * they are the human-readable form of the same data.
 */
export const MeDocument = graphql(/* GraphQL */ `
  query Me {
    me {
      employee {
        id
        firstName
        lastName
        email
      }
      roles {
        id
        roleName
      }
      permissionKeys
    }
  }
`)
