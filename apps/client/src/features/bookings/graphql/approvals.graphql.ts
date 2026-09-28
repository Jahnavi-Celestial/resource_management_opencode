import { graphql } from '@/graphql'

/**
 * The manager's pending queue and the two decision mutations (FR-50–56).
 *
 * The queue query deliberately asks for *nothing* but `page` and `pageSize`:
 * `pendingQueue` takes no `search`, no `filter` and no `sort` argument, and S8's
 * acceptance suite pins the third of those — a `sort` argument is a BAD_USER_INPUT
 * error, because the queue's order is the server's to fix and a client-chosen
 * order over a server-paginated page would be a lie about what is on the page.
 * So the screen offers no search box, no filters and no sortable column, and
 * renders the order the server sent.
 *
 * `requester.name` is the server's already-resolved label here, not a join the
 * client could do: the queue is one page of bookings and the server batches
 * those names in a single loader (NFR-1), which is exactly the N+1 a per-row
 * `displayName()` call over `firstName`/`lastName` would reintroduce. The detail
 * screen is the one that reads the name *parts*, because that is where a deleted
 * requester's fallback has to be re-derived.
 */
export const PendingQueueDocument = graphql(/* GraphQL */ `
  query PendingQueue($page: Int!, $pageSize: Int!) {
    pendingQueue(page: $page, pageSize: $pageSize) {
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
