import { ArgsType, Field, GraphQLISODateTime, ID, InputType } from 'type-graphql'
import { PageArgs } from '../../common/pagination/page-args'
import { AuditActionGraphQL, AuditBookingStatusGraphQL } from './audit.types'

@InputType('AuditLogFilter')
export class AuditLogFilterInput {
  @Field(() => ID, { nullable: true })
  bookingId?: string

  @Field(() => ID, { nullable: true })
  actorId?: string

  @Field(() => ID, { nullable: true })
  performedById?: string

  @Field(() => AuditActionGraphQL, { nullable: true })
  action?: AuditActionGraphQL

  @Field(() => AuditBookingStatusGraphQL, { nullable: true })
  status?: AuditBookingStatusGraphQL

  @Field(() => GraphQLISODateTime, { nullable: true })
  from?: Date

  @Field(() => GraphQLISODateTime, { nullable: true })
  to?: Date

  @Field(() => GraphQLISODateTime, { nullable: true })
  startDate?: Date

  @Field(() => GraphQLISODateTime, { nullable: true })
  endDate?: Date
}

@ArgsType()
export class AuditListArgs extends PageArgs {
  @Field(() => ID, { nullable: true })
  bookingId?: string

  @Field(() => ID, { nullable: true })
  actorId?: string

  @Field(() => ID, { nullable: true })
  performedById?: string

  @Field(() => AuditActionGraphQL, { nullable: true })
  action?: AuditActionGraphQL

  @Field(() => AuditBookingStatusGraphQL, { nullable: true })
  status?: AuditBookingStatusGraphQL

  @Field(() => GraphQLISODateTime, { nullable: true })
  from?: Date

  @Field(() => GraphQLISODateTime, { nullable: true })
  to?: Date
}
