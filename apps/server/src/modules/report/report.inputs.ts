import { IsDate } from 'class-validator'
import { Field, GraphQLISODateTime, InputType } from 'type-graphql'

/**
 * Half-open window `[from, to)` used by the date-ranged reports (FR-66, FR-68).
 * A booking is in scope when its window overlaps it: `start_time < to AND end_time > from`.
 *
 * An `@InputType` rather than the `@ArgsType` that `PageArgs` uses: this is a
 * single named argument (`range: ReportRangeInput`) that the two reports
 * without a mandatory window make nullable, and it is never mixed into a
 * resolver's positional argument list the way `PageArgs` is.
 */
@InputType()
export class ReportRangeInput {
  @Field(() => GraphQLISODateTime)
  @IsDate()
  from!: Date

  @Field(() => GraphQLISODateTime)
  @IsDate()
  to!: Date
}
