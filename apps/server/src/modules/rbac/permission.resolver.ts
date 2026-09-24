import { Arg, Authorized, Ctx, Int, Query, Resolver } from 'type-graphql'
import type { GraphQLContext } from '../../common/graphql/context'
import { PermissionService } from './permission.service'
import { PermissionPage, PermissionType, toPermissionType } from './rbac.types'

@Resolver()
export class PermissionResolver {
  @Query(() => PermissionPage)
  @Authorized('permission:read')
  async permissions(
    @Arg('page', () => Int, { defaultValue: 1 }) page: number,
    @Arg('pageSize', () => Int, { defaultValue: 20 }) pageSize: number,
    @Ctx() context: GraphQLContext,
  ): Promise<PermissionPage> {
    const service = new PermissionService(context.dataSource)
    const { items, total } = await service.listPermissions(page, pageSize)
    return { items: items.map(toPermissionType), total }
  }
}
