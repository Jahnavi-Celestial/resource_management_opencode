import { Arg, Authorized, Ctx, Mutation, Resolver } from 'type-graphql'
import { EmployeeType, toEmployeeType } from '../employee/employee.types'
import type { GraphQLContext } from '../../common/graphql/context'
import { EmployeeRoleInput, RolePermissionInput } from './rbac.inputs'
import { RbacService } from './rbac.service'
import { RoleType, toRoleType } from './rbac.types'

@Resolver()
export class RbacResolver {
  @Mutation(() => RoleType)
  @Authorized('role:write')
  async assignPermissionToRole(
    @Arg('input', () => RolePermissionInput) input: RolePermissionInput,
    @Ctx() context: GraphQLContext,
  ): Promise<RoleType> {
    const service = new RbacService(context.dataSource)
    return toRoleType(await service.assignPermissionToRole(input.roleId, input.permissionId))
  }

  @Mutation(() => RoleType)
  @Authorized('role:write')
  async removePermissionFromRole(
    @Arg('input', () => RolePermissionInput) input: RolePermissionInput,
    @Ctx() context: GraphQLContext,
  ): Promise<RoleType> {
    const service = new RbacService(context.dataSource)
    return toRoleType(await service.removePermissionFromRole(input.roleId, input.permissionId))
  }

  @Mutation(() => EmployeeType)
  @Authorized('role:assign')
  async assignRoleToEmployee(
    @Arg('input', () => EmployeeRoleInput) input: EmployeeRoleInput,
    @Ctx() context: GraphQLContext,
  ): Promise<EmployeeType> {
    const service = new RbacService(context.dataSource)
    return toEmployeeType(await service.assignRoleToEmployee(input.employeeId, input.roleId))
  }

  @Mutation(() => EmployeeType)
  @Authorized('role:assign')
  async removeRoleFromEmployee(
    @Arg('input', () => EmployeeRoleInput) input: EmployeeRoleInput,
    @Ctx() context: GraphQLContext,
  ): Promise<EmployeeType> {
    const service = new RbacService(context.dataSource)
    return toEmployeeType(await service.removeRoleFromEmployee(input.employeeId, input.roleId))
  }
}
