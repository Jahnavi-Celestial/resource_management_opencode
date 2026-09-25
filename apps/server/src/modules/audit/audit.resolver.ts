import { Arg, Args, Authorized, Ctx, FieldResolver, Query, Resolver, Root } from 'type-graphql'
import type DataLoader from 'dataloader'
import type { DataSource } from 'typeorm'
import type { PaginationArgs } from '../../common/pagination/apply-pagination'
import { createPaginatedType, type Paginated } from '../../common/pagination/paginated'
import { SortInput } from '../../common/pagination/sort-input'
import {
  createEmployeeLoader,
  employeeDisplayName,
  loadEmployee,
} from '../../loaders/employee.loader'
import { AuditListArgs, AuditLogFilterInput } from './audit.inputs'
import { AuditRepository } from './audit.repository'
import { AuditService } from './audit.service'
import { AuditActorType, AuditLogType, toAuditActorType } from './audit.types'
import type { Employee } from '../employee/employee.entity'
import type { AuditLog } from './audit-log.entity'
import type { AuditSearchFilters } from './audit.repository'

export const PaginatedAuditLogs = createPaginatedType(AuditLogType, 'AuditLogs')

type EmployeeLoader = DataLoader<string, Employee | null>

type EmployeeLoaders = {
  employee?: EmployeeLoader
  employeeLoader?: EmployeeLoader
  employeeById?: EmployeeLoader
}

export interface AuditGraphQLContext {
  dataSource: DataSource
  loaders?: EmployeeLoaders
}

function getEmployeeLoader(context: AuditGraphQLContext): EmployeeLoader {
  if (context.loaders?.employee !== undefined) {
    return context.loaders.employee
  }
  if (context.loaders?.employeeLoader !== undefined) {
    return context.loaders.employeeLoader
  }
  if (context.loaders?.employeeById !== undefined) {
    return context.loaders.employeeById
  }
  const loader = createEmployeeLoader(context.dataSource)
  if (context.loaders === undefined) {
    context.loaders = { employee: loader }
  } else {
    context.loaders.employee = loader
  }
  return loader
}

function toFilters(
  list: AuditListArgs | undefined,
  filter: AuditLogFilterInput | undefined,
): AuditSearchFilters {
  if (list === undefined && filter === undefined) {
    return {}
  }
  const bookingId = filter?.bookingId ?? list?.bookingId
  const actorId = filter?.actorId ?? filter?.performedById ?? list?.actorId ?? list?.performedById
  const action = filter?.action ?? list?.action
  const status = filter?.status ?? list?.status
  const from = filter?.from ?? filter?.startDate ?? list?.from
  const to = filter?.to ?? filter?.endDate ?? list?.to
  return {
    bookingId,
    actorId,
    action: action as AuditSearchFilters['action'],
    status: status as AuditSearchFilters['status'],
    from: AuditRepository.parseDate(from, 'from'),
    to: AuditRepository.parseDate(to, 'to'),
  }
}

@Resolver(() => AuditLogType)
export class AuditResolver {
  private readonly service = new AuditService()

  @Query(() => PaginatedAuditLogs)
  @Authorized('audit:read')
  async auditLogs(
    @Args(() => AuditListArgs) pagination: AuditListArgs,
    @Arg('sort', () => SortInput, { nullable: true } as never) sort: SortInput | null | undefined,
    @Arg('filter', () => AuditLogFilterInput, { nullable: true } as never) filter: AuditLogFilterInput | null | undefined,
    @Ctx() context: AuditGraphQLContext,
  ): Promise<Paginated<AuditLogType>> {
    return this.service.search(
      context.dataSource.manager,
      pagination as PaginationArgs,
      sort,
      toFilters(pagination, filter ?? undefined),
    )
  }

  @FieldResolver()
  async performedBy(
    @Root() audit: AuditLogType,
    @Ctx() context: AuditGraphQLContext,
  ): Promise<AuditActorType | null> {
    const employee = await loadEmployee(audit.performedById, getEmployeeLoader(context))
    return employee === null
      ? null
      : toAuditActorType({
          id: employee.id,
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          displayName: employeeDisplayName(employee),
        })
  }

  @FieldResolver()
  async performedByName(
    @Root() audit: AuditLogType,
    @Ctx() context: AuditGraphQLContext,
  ): Promise<string> {
    return employeeDisplayName(await loadEmployee(audit.performedById, getEmployeeLoader(context)))
  }

  @FieldResolver()
  async performedByDisplayName(
    @Root() audit: AuditLogType,
    @Ctx() context: AuditGraphQLContext,
  ): Promise<string> {
    return employeeDisplayName(await loadEmployee(audit.performedById, getEmployeeLoader(context)))
  }
}
