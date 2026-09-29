import { graphql } from '@/graphql'

/**
 * The booking list, its create mutation, and the two option queries the create
 * form needs.
 *
 * Two things are deliberate here:
 *
 * - The list's filters are *nested* in one `BookingFilterInput`, because that is
 *   the server's FR-41/42 argument. The shared `DataTable` reports them flat and
 *   by name, so the screen — not the table — nests them; the table never has to
 *   know that this particular endpoint groups its arguments.
 * - `search` is a single argument that the server expands across requester, room,
 *   equipment, purpose and status (FR-41's `EXISTS` joins). The client does not
 *   and cannot guess which of those the user meant, so the search box is one box.
 */
export const BookingsDocument = graphql(/* GraphQL */ `
  query Bookings($page: Int!, $pageSize: Int!, $filter: BookingFilterInput, $sort: SortInput) {
    bookings(page: $page, pageSize: $pageSize, filter: $filter, sort: $sort) {
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
          equipmentId
          name
          requestedQuantity
        }
      }
    }
  }
`)

export const CreateBookingDocument = graphql(/* GraphQL */ `
  mutation CreateBooking($input: CreateBookingInput!) {
    createBooking(input: $input) {
      id
      status
      startTime
      endTime
      purpose
      numberOfAttendees
      room {
        id
        name
      }
      requester {
        id
        name
      }
    }
  }
`)

/**
 * The rooms the create form offers. `activeOnly` is the API's own argument
 * rather than a client-side filter: a retired room cannot be booked, so the
 * server decides what is bookable (S4/S6), and the form renders what it is
 * given. `pageSize: 100` is the server's `MAX_PAGE_SIZE` — the option list is
 * the one place a bounded-but-full collection is right, and a *select* cannot
 * paginate.
 */
export const BookableRoomsDocument = graphql(/* GraphQL */ `
  query BookableRooms($pageSize: Int!, $activeOnly: Boolean!) {
    rooms(page: 1, pageSize: $pageSize, activeOnly: $activeOnly, sort: { field: "name", direction: "ASC" }) {
      items {
        id
        name
        location
        capacity
        isActive
      }
    }
  }
`)

export const BookableEquipmentDocument = graphql(/* GraphQL */ `
  query BookableEquipment($pageSize: Int!, $activeOnly: Boolean!) {
    equipment(page: 1, pageSize: $pageSize, activeOnly: $activeOnly, sort: { field: "name", direction: "ASC" }) {
      items {
        id
        name
        quantityAvailable
        isActive
      }
    }
  }
`)

/**
 * FR-23: what is already booked in a room over a window, asked of the server
 * rather than worked out here.
 *
 * The server owns the overlap question — it applies the same FR-35 "committed"
 * definition its availability check uses, and it holds the row lock a create
 * transaction needs. A client that compared two lists to decide "this looks
 * free" would be doing a second, weaker version of that rule against a stale
 * snapshot, so the client only renders what this returns, including its empty
 * answer.
 */
export const RoomAvailabilityDocument = graphql(/* GraphQL */ `
  query RoomAvailability($roomId: String!, $startDate: DateTimeISO!, $endDate: DateTimeISO!) {
    roomAvailability(roomId: $roomId, startDate: $startDate, endDate: $endDate) {
      id
      startTime
      endTime
      purpose
      status
    }
  }
`)

/**
 * FR-29: how much of one item is still free in a window. `quantityAvailable` is
 * the item's standing total and `remainingAvailability` the server's answer for
 * this window; the screen prints both and never subtracts for itself.
 */
export const EquipmentAvailabilityDocument = graphql(/* GraphQL */ `
  query EquipmentAvailability($equipmentId: String!, $startDate: DateTimeISO!, $endDate: DateTimeISO!) {
    equipmentAvailability(equipmentId: $equipmentId, startDate: $startDate, endDate: $endDate) {
      equipmentId
      name
      quantityAvailable
      remainingAvailability
    }
  }
`)

/**
 * The batched form of FR-29: the window-aware remaining quantity of *every*
 * bookable item in one request, so the equipment select's options can show
 * what the chosen window leaves of each item.
 *
 * The per-item `EquipmentAvailability` cannot answer that — a select of ten
 * options is ten requests — and the client must not subtract bookings itself:
 * the overlap rule is the server's FR-35 definition, evaluated against data
 * the client only has a stale snapshot of. The select's label is the server's
 * number or nothing.
 */
export const EquipmentAvailabilityForWindowDocument = graphql(/* GraphQL */ `
  query EquipmentAvailabilityForWindow($equipmentIds: [String!]!, $startDate: DateTimeISO!, $endDate: DateTimeISO!) {
    equipmentAvailabilityForWindow(equipmentIds: $equipmentIds, startDate: $startDate, endDate: $endDate) {
      equipmentId
      name
      quantityAvailable
      remainingAvailability
    }
  }
`)

/**
 * One booking in full (FR-45–49).
 *
 * The shape of this selection is the detail screen's whole design, so it is worth
 * saying what is *not* here. `processedAt`, `processedBy` and `statusHistory` are
 * not columns on `booking` (§6): there is no `processed_at`/`processed_by_id`,
 * and the server derives all three from the audit log (FR-40/47), which is why
 * `statusHistory` is the audit trail and not a status column someone maintains.
 *
 * It also selects the *parts* of every person — `firstName`/`lastName` on the
 * requester, on the approver and on each history actor — and never the server's
 * pre-joined `name`. That is deliberate: the screen labels them with
 * `displayName()`, the one fallback C1 built and unit-tested against the server's
 * `DELETED_USER_DISPLAY_NAME`, so the string on screen is decided by that one
 * function. Asking for `name` here would hand the screen a finished label and
 * quietly give it a second implementation. (The *list* is the opposite case and
 * keeps using the server's batch-resolved `name` — see `BookingsPage`.)
 */
export const BookingDetailDocument = graphql(/* GraphQL */ `
  query BookingDetail($id: ID!) {
    booking(id: $id) {
      id
      purpose
      status
      rejectionReason
      startTime
      endTime
      numberOfAttendees
      createdAt
      processedAt
      processedBy {
        id
        firstName
        lastName
      }
      requester {
        id
        firstName
        lastName
        email
        recentBookings {
          id
          startTime
          endTime
          purpose
          status
        }
      }
      room {
        id
        name
        location
        capacity
        otherBookings {
          id
          startTime
          endTime
          purpose
          status
        }
      }
      equipmentLines {
        id
        equipmentId
        name
        requestedQuantity
        remainingAvailability
      }
      statusHistory {
        id
        oldStatus
        newStatus
        transitionedAt
        actor {
          id
          firstName
          lastName
        }
      }
    }
  }
`)
