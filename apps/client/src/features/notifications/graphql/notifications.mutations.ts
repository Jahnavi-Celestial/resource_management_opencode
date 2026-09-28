import { graphql } from '@/graphql'

export const MarkNotificationReadDocument = graphql(/* GraphQL */ `
  mutation MarkNotificationRead($id: String!) {
    markNotificationRead(id: $id) {
      id
      isRead
      createdAt
    }
  }
`)

export const MarkAllNotificationsReadDocument = graphql(/* GraphQL */ `
  mutation MarkAllNotificationsRead {
    markAllNotificationsRead
  }
`)
