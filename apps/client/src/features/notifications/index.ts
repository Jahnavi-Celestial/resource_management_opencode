/**
 * The notifications feature. Two surfaces share it: the bell in the
 * AppShell header (part 1 of C3) and the full `/notifications` list
 * (part 2). Neither is gated by a permission — notifications are
 * available to every authenticated user (FR-89 has no notification
 * permission key).
 */

export {
  MarkNotificationReadDocument,
  MarkAllNotificationsReadDocument,
} from '@/features/notifications/graphql/notifications.mutations'
export type {
  MarkNotificationReadMutation,
  MarkAllNotificationsReadMutation,
} from '@/graphql/graphql'
