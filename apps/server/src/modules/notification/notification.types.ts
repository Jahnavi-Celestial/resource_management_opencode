import { Field, GraphQLISODateTime, ID, ObjectType, registerEnumType } from 'type-graphql'
import { type NotificationType } from '@resource-booking/shared'

export enum NotificationTypeGraphQL {
  BOOKING_PENDING = 'BOOKING_PENDING',
  BOOKING_APPROVED = 'BOOKING_APPROVED',
  BOOKING_REJECTED = 'BOOKING_REJECTED',
  BOOKING_CANCELLED = 'BOOKING_CANCELLED',
  REMINDER = 'REMINDER',
}

registerEnumType(NotificationTypeGraphQL, { name: 'NotificationType' })

@ObjectType('Notification')
export class NotificationRecordType {
  @Field(() => ID)
  id!: string

  @Field(() => ID)
  recipientId!: string

  @Field(() => ID)
  bookingId!: string

  @Field(() => NotificationTypeGraphQL)
  type!: NotificationTypeGraphQL

  @Field(() => String)
  title!: string

  @Field(() => String)
  message!: string

  @Field(() => Boolean)
  isRead!: boolean

  @Field(() => GraphQLISODateTime)
  createdAt!: Date
}

export function toNotificationRecordType(notification: {
  id: string
  recipientId: string
  bookingId: string
  type: NotificationType
  title: string
  message: string
  isRead: boolean
  createdAt: Date
}): NotificationRecordType {
  return {
    id: notification.id,
    recipientId: notification.recipientId,
    bookingId: notification.bookingId,
    type: notification.type as NotificationTypeGraphQL,
    title: notification.title,
    message: notification.message,
    isRead: notification.isRead,
    createdAt: notification.createdAt,
  }
}
