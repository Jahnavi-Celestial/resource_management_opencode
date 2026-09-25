import type { EntityManager } from 'typeorm'
import { DomainError } from '../../common/errors/domain-error'
import { applyPagination, type PaginationArgs } from '../../common/pagination/apply-pagination'
import type { SortInput, SortableFields } from '../../common/pagination/sort-input'
import { AuditLog, type AuditAction } from './audit-log.entity'
import type { BookingStatus } from '@resource-booking/shared'

export interface AuditSearchFilters {
  bookingId?: string
  actorId?: string
  action?: AuditAction
  status?: BookingStatus
  from?: Date
  to?: Date
}

const SORTABLE_FIELDS: SortableFields = {
  id: 'audit.id',
  createdAt: 'audit.created_at',
  bookingId: 'audit.booking_id',
  action: 'audit.action',
  oldStatus: 'audit.old_status',
  newStatus: 'audit.new_status',
  performedById: 'audit.performed_by',
}

export class AuditRepository {
  async search(
    manager: EntityManager,
    args: PaginationArgs,
    sort: SortInput | null | undefined,
    filters: AuditSearchFilters,
  ): Promise<{ items: AuditLog[]; totalCount: number }> {
    const qb = manager.getRepository(AuditLog).createQueryBuilder('audit')

    if (filters.bookingId !== undefined) {
      qb.andWhere('audit.booking_id = :bookingId', { bookingId: filters.bookingId })
    }

    if (filters.actorId !== undefined) {
      qb.andWhere('audit.performed_by = :actorId', { actorId: filters.actorId })
    }

    if (filters.action !== undefined) {
      qb.andWhere('audit.action = :action', { action: filters.action })
    }

    if (filters.status !== undefined) {
      qb.andWhere('audit.new_status = :status', { status: filters.status })
    }

    if (filters.from !== undefined) {
      qb.andWhere('audit.created_at >= :from', { from: filters.from })
    }

    if (filters.to !== undefined) {
      qb.andWhere('audit.created_at <= :to', { to: filters.to })
    }

    const totalCount = await qb.getCount()
    applyPagination(qb, args, sort, SORTABLE_FIELDS)
    const items = await qb.getMany()
    return { items, totalCount }
  }

  static parseDate(value: Date | string | undefined, field: string): Date | undefined {
    if (value === undefined) {
      return undefined
    }
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) {
      throw new DomainError(`Invalid ${field} date`)
    }
    return date
  }
}
