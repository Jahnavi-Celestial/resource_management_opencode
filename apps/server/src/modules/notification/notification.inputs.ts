import { ArgsType, Field, InputType } from 'type-graphql'
import { PageArgs } from '../../common/pagination/page-args'
import { NotificationTypeGraphQL } from './notification.types'

@InputType('NotificationFilter')
export class NotificationFilterInput {
  @Field(() => NotificationTypeGraphQL, { nullable: true })
  type?: NotificationTypeGraphQL

  @Field(() => Boolean, { nullable: true })
  unreadOnly?: boolean
}

@ArgsType()
export class NotificationListArgs extends PageArgs {
  @Field(() => NotificationTypeGraphQL, { nullable: true })
  type?: NotificationTypeGraphQL

  @Field(() => Boolean, { nullable: true })
  unreadOnly?: boolean
}
