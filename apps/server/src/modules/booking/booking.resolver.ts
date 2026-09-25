import { BOOKING_STATUSES, type BookingStatus } from '@resource-booking/shared'
import {
  Arg,
  Args,
  Authorized,
  Ctx,
  FieldResolver,
  Root,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  Query,
  registerEnumType,
  Resolver,
} from 'type-graphql'
import { AuthorisationError } from '../../common/errors/authorisation-error'
import type { GraphQLContext } from '../../common/graphql/context'
import {
  DELETED_USER_DISPLAY_NAME,
  employeeDisplayName,
  loadEmployee,
} from '../../loaders/employee.loader'
import { createPaginatedType, type Paginated } from '../../common/pagination/paginated'
import { PageArgs } from '../../common/pagination/page-args'
import { SortInput } from '../../common/pagination/sort-input'
import { BookingService } from './booking.service'
import type { BookingReadScope } from './booking.repository'
import type { Booking } from './booking.entity'

const bookingStatus = Object.fromEntries(
  BOOKING_STATUSES.map((status) => [status, status]),
) as Record<BookingStatus, BookingStatus>
registerEnumType(bookingStatus, { name: 'BookingListStatus' })

@InputType()
export class BookingFilterInput {
  @Field(() => String, { nullable: true })
  search?: string

  @Field(() => bookingStatus, { nullable: true })
  status?: BookingStatus

  @Field(() => GraphQLISODateTime, { nullable: true })
  startDate?: Date

  @Field(() => GraphQLISODateTime, { nullable: true })
  endDate?: Date
}

@ObjectType()
export class BookingType {
  @Field(() => ID)
  id!: string

  @Field(() => ID, { nullable: true })
  employeeId!: string | null

  @Field(() => ID)
  roomId!: string

  @Field(() => GraphQLISODateTime)
  startTime!: Date

  @Field(() => GraphQLISODateTime)
  endTime!: Date

  @Field(() => String)
  purpose!: string

  @Field(() => String, { nullable: true })
  rejectionReason!: string | null

  @Field(() => Int)
  numberOfAttendees!: number

  @Field(() => bookingStatus)
  status!: BookingStatus

  @Field(() => GraphQLISODateTime)
  createdAt!: Date

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date

  @Field(() => GraphQLISODateTime, { nullable: true })
  processedAt!: Date | null

  @Field(() => BookingActorType, { nullable: true })
  processedBy!: BookingActorType | null

  @Field(() => [BookingStatusTransitionType])
  statusHistory!: BookingStatusTransitionType[]

  @Field(() => BookingRequesterType)
  requester!: BookingRequesterType

  @Field(() => BookingRoomType)
  room!: BookingRoomType

  @Field(() => [BookingEquipmentDetailType])
  equipmentLines!: BookingEquipmentDetailType[]
}

@ObjectType('BookingActor')
class BookingActorType {
  @Field(() => ID, { nullable: true })
  id!: string | null

  @Field(() => String)
  name!: string
}

@ObjectType('BookingStatusTransition')
class BookingStatusTransitionType {
  @Field(() => ID)
  id!: string

  @Field(() => bookingStatus, { nullable: true })
  oldStatus!: BookingStatus | null

  @Field(() => bookingStatus)
  newStatus!: BookingStatus

  @Field(() => BookingActorType)
  actor!: BookingActorType

  @Field(() => GraphQLISODateTime)
  transitionedAt!: Date
}

@ObjectType('BookingSummary')
class BookingSummaryType {
  @Field(() => ID)
  id!: string

  @Field(() => GraphQLISODateTime)
  startTime!: Date

  @Field(() => GraphQLISODateTime)
  endTime!: Date

  @Field(() => String)
  purpose!: string

  @Field(() => bookingStatus)
  status!: BookingStatus
}

@ObjectType('BookingRequester')
class BookingRequesterType {
  @Field(() => ID, { nullable: true })
  id!: string | null

  @Field(() => String)
  name!: string

  @Field(() => String)
  email!: string

  @Field(() => [BookingSummaryType])
  recentBookings!: BookingSummaryType[]
}

@ObjectType('BookingRoom')
class BookingRoomType {
  @Field(() => ID)
  id!: string

  @Field(() => String)
  name!: string

  @Field(() => String)
  location!: string

  @Field(() => Int)
  capacity!: number

  @Field(() => [BookingSummaryType])
  otherBookings!: BookingSummaryType[]
}

@ObjectType('BookingEquipmentDetail')
class BookingEquipmentDetailType {
  @Field(() => ID)
  id!: string

  @Field(() => ID)
  equipmentId!: string

  @Field(() => String)
  name!: string

  @Field(() => Int)
  requestedQuantity!: number

  @Field(() => Int)
  remainingAvailability!: number
}

export const PaginatedBookings = createPaginatedType(BookingType, 'Bookings')

function toBookingSummary(
  booking: Pick<Booking, 'id' | 'startTime' | 'endTime' | 'purpose' | 'status'>,
): BookingSummaryType {
  return {
    id: booking.id,
    startTime: booking.startTime,
    endTime: booking.endTime,
    purpose: booking.purpose,
    status: booking.status,
  }
}

async function toBookingActor(
  employeeId: string | null,
  context: GraphQLContext,
): Promise<BookingActorType> {
  const employee = await loadEmployee(employeeId, context.loaders.employee)
  return {
    id: employee?.id ?? null,
    name: employeeDisplayName(employee),
  }
}

export function readScope(context: GraphQLContext): BookingReadScope {
  const auth = context.auth
  if (auth === null) {
    throw new AuthorisationError()
  }
  if (auth.permissionKeys.has('booking:read:all')) {
    return { kind: 'all' }
  }
  if (!auth.permissionKeys.has('booking:read:own')) {
    throw new AuthorisationError()
  }
  return { kind: 'own', employeeId: auth.employee.id }
}

@Resolver(() => BookingType)
export class BookingResolver {
  @Query(() => PaginatedBookings)
  @Authorized()
  async bookings(
    @Ctx() context: GraphQLContext,
    @Args(() => PageArgs) pagination: PageArgs,
    @Arg('sort', () => SortInput, { nullable: true }) sort: SortInput | null,
    @Arg('filter', () => BookingFilterInput, { nullable: true }) filter: BookingFilterInput | null,
  ): Promise<Paginated<Booking>> {
    const service = new BookingService(context.dataSource)
    return service.list(readScope(context), pagination, sort, filter)
  }

  @Query(() => BookingType)
  @Authorized()
  async booking(
    @Ctx() context: GraphQLContext,
    @Arg('id', () => ID) id: string,
  ): Promise<Booking> {
    const service = new BookingService(context.dataSource)
    const booking = await service.getVisibleById(id, readScope(context))
    if (booking === null) {
      throw new AuthorisationError()
    }
    return booking
  }

  @FieldResolver()
  async processedAt(@Root() booking: Booking, @Ctx() context: GraphQLContext): Promise<Date | null> {
    const audit = await context.loaders.latestProcessingAudit.load(booking.id)
    return audit?.createdAt ?? null
  }

  @FieldResolver()
  async processedBy(
    @Root() booking: Booking,
    @Ctx() context: GraphQLContext,
  ): Promise<BookingActorType | null> {
    const audit = await context.loaders.latestProcessingAudit.load(booking.id)
    return audit === null ? null : toBookingActor(audit.performedById, context)
  }

  @FieldResolver()
  async requester(
    @Root() booking: Booking,
    @Ctx() context: GraphQLContext,
  ): Promise<BookingRequesterType> {
    const employee = await loadEmployee(booking.employeeId, context.loaders.employee)
    const recentBookings =
      employee === null
        ? []
        : await context.loaders.recentEmployeeBookings.load({
            employeeId: employee.id,
            excludeBookingId: booking.id,
            scope: readScope(context),
          })
    return {
      id: employee?.id ?? null,
      name: employeeDisplayName(employee),
      email: employee?.email ?? DELETED_USER_DISPLAY_NAME,
      recentBookings: recentBookings.map(toBookingSummary),
    }
  }

  @FieldResolver()
  async statusHistory(
    @Root() booking: Booking,
    @Ctx() context: GraphQLContext,
  ): Promise<BookingStatusTransitionType[]> {
    const history = await context.loaders.bookingStatusHistory.load(booking.id)
    return Promise.all(
      history.map(async (entry) => ({
        id: entry.id,
        oldStatus: entry.oldStatus,
        newStatus: entry.newStatus,
        actor: await toBookingActor(entry.performedById, context),
        transitionedAt: entry.createdAt,
      })),
    )
  }

  @FieldResolver()
  async room(@Root() booking: Booking, @Ctx() context: GraphQLContext): Promise<BookingRoomType> {
    const room = await context.loaders.bookingRoom.load(booking.roomId)
    if (room === null) {
      throw new Error(`Booking room ${booking.roomId} does not exist`)
    }
    const otherBookings = await context.loaders.overlappingRoomBookings.load({
      bookingId: booking.id,
      roomId: booking.roomId,
      startTime: booking.startTime,
      endTime: booking.endTime,
      scope: readScope(context),
    })
    return {
      id: room.id,
      name: room.name,
      location: room.location,
      capacity: room.capacity,
      otherBookings: otherBookings.map(toBookingSummary),
    }
  }

  @FieldResolver()
  async equipmentLines(
    @Root() booking: Booking,
    @Ctx() context: GraphQLContext,
  ): Promise<BookingEquipmentDetailType[]> {
    const lines = await context.loaders.bookingEquipmentLines.load(booking.id)
    return Promise.all(
      lines.map(async (line) => ({
        id: line.id,
        equipmentId: line.equipmentId,
        name: line.equipment.name,
        requestedQuantity: line.quantity,
        remainingAvailability: await context.loaders.equipmentAvailability.load({
          equipmentId: line.equipmentId,
          startTime: booking.startTime,
          endTime: booking.endTime,
        }),
      })),
    )
  }
}
