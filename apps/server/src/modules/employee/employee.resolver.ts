import { Arg, Args, Authorized, Ctx, FieldResolver, Mutation, Query, Resolver, Root } from 'type-graphql'
import { AuthorisationError } from '../../common/errors/authorisation-error'
import type { DataSource } from 'typeorm'
import type { GraphQLContext } from '../../common/graphql/context'
import type { Paginated } from '../../common/pagination/paginated'
import { Booking } from '../booking/booking.entity'
import { RoleType, toRoleType } from '../rbac/rbac.types'
import { CreateEmployeeInput, EmployeeListArgs, UpdateEmployeeInput } from './employee.inputs'
import { EmployeeService } from './employee.service'
import { EmployeeType, EmployeeBookingSummary, PaginatedEmployees, toEmployeeType } from './employee.types'

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

  @Query(() => EmployeeType)
  @Authorized('employee:read')
  async employee(
    @Arg('id', () => String) id: string,
    @Ctx() context: GraphQLContext,
  ): Promise<EmployeeType> {
    const service = new EmployeeService(context.dataSource)
    return toEmployeeType(await service.getById(id))
  }

  @FieldResolver(() => [RoleType])
  async roles(@Root() employee: EmployeeType, @Ctx() context: GraphQLContext): Promise<RoleType[]> {
    const roles = await context.loaders.employeeRoles.load(employee.id)
    return roles.map(toRoleType)
  }

  @FieldResolver(() => [EmployeeBookingSummary])
  async bookingHistory(@Root() employee: EmployeeType, @Ctx() context: GraphQLContext): Promise<EmployeeBookingSummary[]> {
    if (employee.id === null) return []
    const repository = context.dataSource.getRepository(Booking)
    const bookings = await repository.find({
      where: { employeeId: employee.id },
      order: { createdAt: 'DESC' },
    })
    return bookings.map((b) => ({
      id: b.id,
      startTime: b.startTime,
      endTime: b.endTime,
      purpose: b.purpose,
      status: b.status,
    }))
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
