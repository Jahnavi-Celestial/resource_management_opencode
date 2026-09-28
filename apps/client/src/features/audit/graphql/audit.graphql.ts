import { graphql } from '@/graphql'

export const AuditLogsDocument = graphql(/* GraphQL */ `
  query AuditLogs(
    $page: Int!
    $pageSize: Int!
    $bookingId: ID
    $performedById: ID
    $action: AuditAction
    $status: BookingStatus
    $from: DateTimeISO
    $to: DateTimeISO
    $sort: SortInput
  ) {
    auditLogs(
      page: $page
      pageSize: $pageSize
      bookingId: $bookingId
      performedById: $performedById
      action: $action
      status: $status
      from: $from
      to: $to
      sort: $sort
    ) {
      totalCount
      items {
        id
        bookingId
        action
        oldStatus
        newStatus
        performedBy {
          id
          firstName
          lastName
        }
        createdAt
      }
    }
  }
`)
