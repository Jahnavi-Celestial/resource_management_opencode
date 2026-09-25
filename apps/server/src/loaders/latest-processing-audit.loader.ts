import DataLoader from 'dataloader'
import type { DataSource } from 'typeorm'
import { AuditLog } from '../modules/audit/audit-log.entity'

export function createLatestProcessingAuditLoader(
  dataSource: DataSource,
): DataLoader<string, AuditLog | null> {
  return new DataLoader<string, AuditLog | null>(async (bookingIds: readonly string[]) => {
    const audits = await dataSource
      .getRepository(AuditLog)
      .createQueryBuilder('audit')
      .where('audit.booking_id IN (:...bookingIds)', { bookingIds: [...bookingIds] })
      .andWhere(
        `audit.id = (
          SELECT latest.id
          FROM audit_log latest
          WHERE latest.booking_id = audit.booking_id
            AND latest.action IN (:...latestActions)
          ORDER BY latest.created_at DESC, latest.id DESC
          LIMIT 1
        )`,
        { latestActions: ['APPROVE', 'REJECT'] },
      )
      .orderBy('audit.booking_id', 'ASC')
      .addOrderBy('audit.created_at', 'DESC')
      .addOrderBy('audit.id', 'DESC')
      .getMany()

    const byBookingId = new Map(audits.map((audit) => [audit.bookingId, audit]))
    return bookingIds.map((bookingId) => byBookingId.get(bookingId) ?? null)
  })
}
