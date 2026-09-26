import { Arg, Args, Authorized, Ctx, Int, Mutation, Query, Resolver } from 'type-graphql'
import { AuthorisationError } from '../../common/errors/authorisation-error'
import type { GraphQLContext } from '../../common/graphql/context'
import { createPaginatedType, type Paginated } from '../../common/pagination/paginated'
import { SortInput } from '../../common/pagination/sort-input'
import { NotificationListArgs } from './notification.inputs'
import type { NotificationFilters } from './notification.repository'
import { NotificationService } from './notification.service'
import { NotificationRecordType } from './notification.types'

export const PaginatedNotifications = createPaginatedType(NotificationRecordType, 'Notifications')

function recipientId(context: GraphQLContext): string {
  if (context.auth === null) {
    throw new AuthorisationError()
  }
  return context.auth.employee.id
}

function toFilters(args: NotificationListArgs): NotificationFilters {
  return {
    type: args.type as NotificationFilters['type'],
    unreadOnly: args.unreadOnly,
  }
}

@Resolver(() => NotificationRecordType)
export class NotificationResolver {
  @Query(() => PaginatedNotifications)
  @Authorized()
  async myNotifications(
    @Ctx() context: GraphQLContext,
    @Args(() => NotificationListArgs) pagination: NotificationListArgs,
    @Arg('sort', () => SortInput, { nullable: true }) sort: SortInput | null,
  ): Promise<Paginated<NotificationRecordType>> {
    const service = new NotificationService()
    return service.list(
      context.dataSource.manager,
      recipientId(context),
      pagination,
      sort,
      toFilters(pagination),
    )
  }

  @Query(() => Int)
  @Authorized()
  async unreadCount(@Ctx() context: GraphQLContext): Promise<number> {
    const service = new NotificationService()
    return service.unreadCount(context.dataSource.manager, recipientId(context))
  }

  @Mutation(() => NotificationRecordType)
  @Authorized()
  async markNotificationRead(
    @Ctx() context: GraphQLContext,
    @Arg('id', () => String) id: string,
  ): Promise<NotificationRecordType> {
    const service = new NotificationService()
    return service.markRead(context.dataSource.manager, recipientId(context), id)
  }

  @Mutation(() => Int)
  @Authorized()
  async markAllNotificationsRead(@Ctx() context: GraphQLContext): Promise<number> {
    const service = new NotificationService()
    return service.markAllRead(context.dataSource.manager, recipientId(context))
  }
}
