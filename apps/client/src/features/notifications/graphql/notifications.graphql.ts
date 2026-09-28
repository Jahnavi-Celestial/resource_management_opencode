import { graphql } from '@/graphql'

/**
 * The two notification reads the realtime client keeps fresh.
 *
 * They are the *only* notification queries that exist so far, and both are
 * declared here — next to the socket hook that refetches them — because the
 * notification list and the bell itself (C3 part 2) read the same two
 * operations and must not issue their own.
 *
 * The operation names matter: `useNotificationSocket` refetches by name
 * (`client.refetchQueries({ include: [...] })`) both on every (re)open and after
 * every `notification.created` event, so renaming either of these silently turns
 * that refetch into a no-op.
 */
export const UnreadCountDocument = graphql(/* GraphQL */ `
  query UnreadCount {
    unreadCount
  }
`)

/**
 * The notification list. `sort` and `page` are arguments rather than baked-in
 * values so the list screen can page and sort server-side (NFR-7) without
 * changing this document; the socket hook refetches whatever argument set the
 * screen is currently using.
 */
export const MyNotificationsDocument = graphql(/* GraphQL */ `
  query MyNotifications(
    $page: Int!
    $pageSize: Int!
    $sort: SortInput
    $type: NotificationType
    $unreadOnly: Boolean
  ) {
    myNotifications(
      page: $page
      pageSize: $pageSize
      sort: $sort
      type: $type
      unreadOnly: $unreadOnly
    ) {
      totalCount
      items {
        id
        recipientId
        bookingId
        type
        title
        message
        isRead
        createdAt
      }
    }
  }
`)
