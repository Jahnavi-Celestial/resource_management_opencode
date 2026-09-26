import type { EntityManager } from 'typeorm'
import { applyPagination, type PaginationArgs } from '../../common/pagination/apply-pagination'
import type { SortInput, SortableFields } from '../../common/pagination/sort-input'
import { Notification } from './notification.entity'
import { Permission } from '../rbac/permission.entity'
import { RolePermission } from '../rbac/role-permission.entity'
import { UserRole } from '../rbac/user-role.entity'
import type { NotificationType, PermissionKey } from '@resource-booking/shared'

export const APPROVE_PERMISSION: PermissionKey = 'booking:approve'

export interface NotificationFilters {
  type?: NotificationType | null
  unreadOnly?: boolean | null
}

const SORTABLE_FIELDS: SortableFields = {
  id: 'notification.id',
  createdAt: 'notification.created_at',
  type: 'notification.type',
  isRead: 'notification.is_read',
}

export class NotificationRepository {
  async list(
    manager: EntityManager,
    recipientId: string,
    args: PaginationArgs,
    sort: SortInput | null | undefined,
    filters: NotificationFilters = {},
  ): Promise<{ items: Notification[]; totalCount: number }> {
    const qb = manager
      .getRepository(Notification)
      .createQueryBuilder('notification')
      .where('notification.recipient_id = :recipientId', { recipientId })

    if (filters.type) {
      qb.andWhere('notification.type = :type', { type: filters.type })
    }

    if (filters.unreadOnly === true) {
      qb.andWhere('notification.is_read = false')
    }

    const totalCount = await qb.getCount()
    applyPagination(qb, args, sort ?? { field: 'createdAt', direction: 'DESC' }, SORTABLE_FIELDS)
    const items = await qb.getMany()
    return { items, totalCount }
  }

  countUnread(manager: EntityManager, recipientId: string): Promise<number> {
    return manager
      .getRepository(Notification)
      .createQueryBuilder('notification')
      .where('notification.recipient_id = :recipientId', { recipientId })
      .andWhere('notification.is_read = false')
      .getCount()
  }

  async markRead(manager: EntityManager, recipientId: string, id: string): Promise<Notification | null> {
    const repository = manager.getRepository(Notification)
    await repository.update({ id, recipientId, isRead: false }, { isRead: true })
    return repository.findOne({ where: { id, recipientId } })
  }

  async markAllRead(manager: EntityManager, recipientId: string): Promise<number> {
    const result = await manager
      .getRepository(Notification)
      .createQueryBuilder()
      .update(Notification)
      .set({ isRead: true })
      .where('recipient_id = :recipientId', { recipientId })
      .andWhere('is_read = false')
      .execute()
    return result.affected ?? 0
  }

  async findApproverEmployeeIds(
    manager: EntityManager,
    excludeEmployeeId?: string,
  ): Promise<string[]> {
    const qb = manager
      .getRepository(UserRole)
      .createQueryBuilder('userRole')
      .innerJoin(RolePermission, 'rolePermission', 'rolePermission.role_id = userRole.role_id')
      .innerJoin(Permission, 'permission', 'permission.id = rolePermission.permission_id')
      .select('DISTINCT userRole.employee_id', 'employeeId')
      .where('permission.permission_name = :permission', { permission: APPROVE_PERMISSION })

    if (excludeEmployeeId !== undefined) {
      qb.andWhere('userRole.employee_id != :excludeEmployeeId', { excludeEmployeeId })
    }

    const rows = await qb.getRawMany<{ employeeId: string }>()
    return rows.map((row) => row.employeeId)
  }
}
