import { Arg, Authorized, Ctx, FieldResolver, Int, Mutation, Query, Resolver, Root } from 'type-graphql'
import type { GraphQLContext } from '../../common/graphql/context'
import { CreateRoleInput, UpdateRoleInput } from './role.inputs'
import { RoleService } from './role.service'
import { PermissionType, RolePage, RoleType, toPermissionType, toRoleType } from './rbac.types'

@Resolver(() => RoleType)
export class RoleResolver {
  @Query(() => RoleType)
  @Authorized('role:read')
  async role(@Arg('id', () => String) id: string, @Ctx() context: GraphQLContext): Promise<RoleType> {
    const service = new RoleService(context.dataSource)
    return toRoleType(await service.getRole(id))
  }

  @Query(() => RolePage)
  @Authorized('role:read')
  async roles(
    @Arg('page', () => Int, { defaultValue: 1 }) page: number,
    @Arg('pageSize', () => Int, { defaultValue: 20 }) pageSize: number,
    @Ctx() context: GraphQLContext,
  ): Promise<RolePage> {
    const service = new RoleService(context.dataSource)
    const { items, total } = await service.listRoles(page, pageSize)
    return { items: items.map(toRoleType), total }
  }

  @Mutation(() => RoleType)
  @Authorized('role:write')
  async createRole(
    @Arg('input', () => CreateRoleInput) input: CreateRoleInput,
    @Ctx() context: GraphQLContext,
  ): Promise<RoleType> {
    const service = new RoleService(context.dataSource)
    return toRoleType(await service.createRole(input.roleName))
  }

  @Mutation(() => RoleType)
  @Authorized('role:write')
  async updateRole(
    @Arg('input', () => UpdateRoleInput) input: UpdateRoleInput,
    @Ctx() context: GraphQLContext,
  ): Promise<RoleType> {
    const service = new RoleService(context.dataSource)
    return toRoleType(await service.updateRole(input.id, input.roleName))
  }

  @Mutation(() => Boolean)
  @Authorized('role:write')
  async deleteRole(@Arg('id', () => String) id: string, @Ctx() context: GraphQLContext): Promise<boolean> {
    const service = new RoleService(context.dataSource)
    await service.deleteRole(id)
    return true
  }

  @FieldResolver(() => [PermissionType])
  async permissions(@Root() role: RoleType, @Ctx() context: GraphQLContext): Promise<PermissionType[]> {
    const permissions = await context.loaders.rolePermissions.load(role.id)
    return permissions.map(toPermissionType)
  }
}
