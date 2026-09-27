import { graphql } from '@/graphql'

/**
 * The room list. `minCapacity`, `maxCapacity` and `activeOnly` are declared as
 * *variables* rather than being folded into `search` so the generic
 * `DataTable`'s filter bar can address them by argument name — the screen never
 * builds a filter string the server has to re-parse.
 */
export const RoomsDocument = graphql(/* GraphQL */ `
  query Rooms(
    $page: Int!
    $pageSize: Int!
    $search: String
    $minCapacity: Int
    $maxCapacity: Int
    $activeOnly: Boolean! = false
    $sort: SortInput
  ) {
    rooms(
      page: $page
      pageSize: $pageSize
      search: $search
      minCapacity: $minCapacity
      maxCapacity: $maxCapacity
      activeOnly: $activeOnly
      sort: $sort
    ) {
      totalCount
      items {
        id
        name
        location
        capacity
        isActive
        createdAt
      }
    }
  }
`)

export const CreateRoomDocument = graphql(/* GraphQL */ `
  mutation CreateRoom($input: CreateRoomInput!) {
    createRoom(input: $input) {
      id
      name
    }
  }
`)

export const UpdateRoomDocument = graphql(/* GraphQL */ `
  mutation UpdateRoom($input: UpdateRoomInput!) {
    updateRoom(input: $input) {
      id
      name
    }
  }
`)
