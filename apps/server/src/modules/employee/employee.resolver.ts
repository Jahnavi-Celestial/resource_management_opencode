import { Arg, Args, Authorized, Ctx, Mutation, Query, Resolver } from 'type-graphql'
import { AuthorisationError } from '../../common/errors/authorisation-error'
import type { GraphQLContext } from '../../common/graphql/context'
import type { Paginated } from '../../common/pagination/paginated'
import { CreateEmployeeInput, EmployeeListArgs, UpdateEmployeeInput } from './employee.inputs'
import { EmployeeService } from './employee.service'
import {
  EmployeeDetailType,
  EmployeeType,
  PaginatedEmployees,
  toEmployeeDetailType,
  toEmployeeType,
} from './employee.types'

@Resolver(() => EmployeeType)
export class EmployeeResolver {
  @Query(() => PaginatedEmployees)
  @Authorized('employee:read')
  async employees(
    @Args(() => EmployeeListArgs) args: EmployeeListArgs,
    @Ctx() context: GraphQLContext,
  ): Promise<Paginated<EmployeeType>> {
    const service = new EmployeeService(context.dataSource)
    const { items, total } = await service.list(args)
    return { items: items.map(toEmployeeType), totalCount: total }
  }

  @Query(() => EmployeeDetailType)
  @Authorized('employee:read')
  async employee(
    @Arg('id', () => String) id: string,
    @Ctx() context: GraphQLContext,
  ): Promise<EmployeeDetailType> {
    const service = new EmployeeService(context.dataSource)
    const { employee, roles } = await service.getDetail(id)
    return toEmployeeDetailType(employee, roles)
  }

  @Mutation(() => EmployeeType)
  @Authorized('employee:write')
  async createEmployee(
    @Arg('input', () => CreateEmployeeInput) input: CreateEmployeeInput,
    @Ctx() context: GraphQLContext,
  ): Promise<EmployeeType> {
    const service = new EmployeeService(context.dataSource)
    return toEmployeeType(await service.create(input))
  }

  @Mutation(() => EmployeeType)
  @Authorized('employee:write')
  async updateEmployee(
    @Arg('input', () => UpdateEmployeeInput) input: UpdateEmployeeInput,
    @Ctx() context: GraphQLContext,
  ): Promise<EmployeeType> {
    const service = new EmployeeService(context.dataSource)
    return toEmployeeType(await service.update(input))
  }

  @Mutation(() => Boolean)
  @Authorized('employee:write')
  async deleteEmployee(
    @Arg('id', () => String) id: string,
    @Ctx() context: GraphQLContext,
  ): Promise<boolean> {
    if (context.auth === null) throw new AuthorisationError()
    const service = new EmployeeService(context.dataSource)
    await service.delete(id, context.auth.employee.id)
    return true
  }
}
