import type { EntityManager } from 'typeorm'
import { AuditLog, type AuditAction } from './audit-log.entity'
import { AuditRepository, type AuditSearchFilters } from './audit.repository'
import { toAuditLogType, type AuditLogType } from './audit.types'
import type { PaginationArgs } from '../../common/pagination/apply-pagination'
import type { SortInput } from '../../common/pagination/sort-input'
import type { Paginated } from '../../common/pagination/paginated'
import type { BookingStatus } from '@resource-booking/shared'

export type AuditRecordInput = {
  bookingId: string
  action: AuditAction
  oldStatus?: BookingStatus | null
  newStatus: BookingStatus
  performedBy?: string
  performedById?: string
}

export class AuditService {
  private readonly repository: AuditRepository

  constructor(repository = new AuditRepository()) {
    this.repository = repository
  }

  async record(manager: EntityManager, input: AuditRecordInput): Promise<AuditLog> {
    const performedBy = input.performedBy ?? input.performedById
    if (performedBy === undefined) {
      throw new Error('Audit actor is required')
    }
    const repository = manager.getRepository(AuditLog)
    return repository.save(
      repository.create({
        bookingId: input.bookingId,
        action: input.action,
        oldStatus: input.oldStatus ?? null,
        newStatus: input.newStatus,
        performedById: performedBy,
      }),
    )
  }

  async search(
    manager: EntityManager,
    args: PaginationArgs,
    sort: SortInput | null | undefined,
    filters: AuditSearchFilters,
  ): Promise<Paginated<AuditLogType>> {
    const result = await this.repository.search(manager, args, sort, filters)
    return {
      items: result.items.map(toAuditLogType),
      totalCount: result.totalCount,
    }
  }
}
