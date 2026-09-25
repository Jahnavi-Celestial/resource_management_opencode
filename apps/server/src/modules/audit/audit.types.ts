import { Field, GraphQLISODateTime, ID, ObjectType, registerEnumType } from 'type-graphql'
import { type BookingStatus } from '@resource-booking/shared'
import { type AuditAction } from './audit-log.entity'

export enum AuditActionGraphQL {
  CREATE = 'CREATE',
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  CANCEL = 'CANCEL',
  COMPLETE = 'COMPLETE',
}

registerEnumType(AuditActionGraphQL, { name: 'AuditAction' })

export enum AuditBookingStatusGraphQL {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
}

registerEnumType(AuditBookingStatusGraphQL, { name: 'BookingStatus' })

@ObjectType('AuditActor')
export class AuditActorType {
  @Field(() => ID)
  id!: string

  @Field(() => String)
  firstName!: string

  @Field(() => String)
  lastName!: string

  @Field(() => String)
  email!: string

  @Field(() => String)
  displayName!: string
}

@ObjectType('AuditLog')
export class AuditLogType {
  @Field(() => ID)
  id!: string

  @Field(() => ID)
  bookingId!: string

  @Field(() => AuditActionGraphQL)
  action!: AuditActionGraphQL

  @Field(() => AuditBookingStatusGraphQL, { nullable: true })
  oldStatus!: AuditBookingStatusGraphQL | null

  @Field(() => AuditBookingStatusGraphQL)
  newStatus!: AuditBookingStatusGraphQL

  @Field(() => ID, { nullable: true })
  performedById!: string | null

  @Field(() => AuditActorType, { nullable: true })
  performedBy!: AuditActorType | null

  @Field(() => String)
  performedByName!: string

  @Field(() => String)
  performedByDisplayName!: string

  @Field(() => GraphQLISODateTime)
  createdAt!: Date
}

export function toAuditActorType(employee: {
  id: string
  firstName: string
  lastName: string
  email: string
  displayName: string
}): AuditActorType {
  return {
    id: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    email: employee.email,
    displayName: employee.displayName,
  }
}

export function toAuditLogType(log: {
  id: string
  bookingId: string
  action: AuditAction
  oldStatus: BookingStatus | null
  newStatus: BookingStatus
  performedById: string | null
  createdAt: Date
}): AuditLogType {
  return {
    id: log.id,
    bookingId: log.bookingId,
    action: log.action as AuditActionGraphQL,
    oldStatus: log.oldStatus as AuditBookingStatusGraphQL | null,
    newStatus: log.newStatus as AuditBookingStatusGraphQL,
    performedById: log.performedById,
    performedBy: null,
    performedByName: '',
    performedByDisplayName: '',
    createdAt: log.createdAt,
  }
}
