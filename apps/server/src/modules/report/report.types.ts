import { Field, Float, Int, ObjectType, registerEnumType } from 'type-graphql'
import { BOOKING_STATUSES, type BookingStatus } from '@resource-booking/shared'

const reportStatusEnum = Object.fromEntries(
  BOOKING_STATUSES.map((status) => [status, status]),
) as Record<BookingStatus, BookingStatus>
registerEnumType(reportStatusEnum, { name: 'ReportBookingStatus' })

/** Enum used by the `statuses` report filter argument (FR-89 statuses only). */
export const REPORT_STATUS_ENUM = reportStatusEnum

@ObjectType('MostBookedRoom')
export class MostBookedRoomType {
  @Field(() => String)
  roomId!: string

  @Field(() => String)
  roomName!: string

  @Field(() => String)
  location!: string

  @Field(() => Int)
  capacity!: number

  @Field(() => Int)
  bookingCount!: number
}

@ObjectType('EmployeeBookingBreakdown')
export class EmployeeBookingBreakdownType {
  @Field(() => String, { nullable: true })
  employeeId!: string | null

  @Field(() => String)
  displayName!: string

  @Field(() => String, { nullable: true })
  email!: string | null

  @Field(() => Int)
  totalCount!: number

  @Field(() => Int)
  pendingCount!: number

  @Field(() => Int)
  approvedCount!: number

  @Field(() => Int)
  rejectedCount!: number

  @Field(() => Int)
  cancelledCount!: number

  @Field(() => Int)
  completedCount!: number
}

@ObjectType('EquipmentUsage')
export class EquipmentUsageType {
  @Field(() => String)
  equipmentId!: string

  @Field(() => String)
  equipmentName!: string

  @Field(() => Int)
  quantityAvailable!: number

  @Field(() => Int)
  bookingCount!: number

  @Field(() => Int)
  totalQuantityCommitted!: number

  @Field(() => Float)
  totalQuantityHours!: number
}

@ObjectType('MonthlyBookingStat')
export class MonthlyBookingStatType {
  @Field(() => String)
  month!: string

  @Field(() => Int)
  created!: number

  @Field(() => Int)
  approved!: number

  @Field(() => Int)
  rejected!: number

  @Field(() => Int)
  cancelled!: number
}
