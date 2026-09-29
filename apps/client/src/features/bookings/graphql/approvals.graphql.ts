import { graphql } from '@/graphql'

/**
 * The manager's pending queue and the two decision mutations (FR-50–56).
 *
 * The queue is a work list, so it defaults to newest-first (`createdAt DESC`,
 * the server's default when no `sort` is sent) and the screen's columns are
 * sortable through the same `sort` argument the bookings list takes — validated
 * against the server's sortable-field whitelist, so a non-whitelisted field is a
 * DomainError rather than an SQL error. `search` is the same LIKE the bookings
 * list uses (requester, room, equipment, purpose, status).
 *
 * `requester.name` is the server's already-resolved label here, not a join the
 * client could do: the queue is one page of bookings and the server batches
 * those names in a single loader (NFR-1), which is exactly the N+1 a per-row
 * `displayName()` call over `firstName`/`lastName` would reintroduce. The detail
 * screen is the one that reads the name *parts*, because that is where a deleted
 * requester's fallback has to be re-derived.
 */
export const PendingQueueDocument = graphql(/* GraphQL */ `
  query PendingQueue($page: Int!, $pageSize: Int!, $search: String, $sort: SortInput) {
    pendingQueue(page: $page, pageSize: $pageSize, search: $search, sort: $sort) {
      totalCount
      items {
        id
        startTime
        endTime
        purpose
        numberOfAttendees
        status
        createdAt
        requester {
          id
          name
        }
        room {
          id
          name
        }
        equipmentLines {
          name
          requestedQuantity
        }
      }
    }
  }
`)

/**
 * The decision is the server's to report: both mutations return the booking it
 * actually wrote, and the screen shows *that* status rather than a hardcoded
 * "approved". A decision can be refused for reasons no client can check (FR-52's
 * re-validation, FR-56's self-decision), so the response is the only honest
 * source of what happened.
 */
export const ApproveBookingDocument = graphql(/* GraphQL */ `
  mutation ApproveBooking($id: ID!) {
    approveBooking(id: $id) {
      id
      status
    }
  }
`)

export const RejectBookingDocument = graphql(/* GraphQL */ `
  mutation RejectBooking($input: RejectBookingInput!) {
    rejectBooking(input: $input) {
      id
      status
      rejectionReason
    }
  }
`)
