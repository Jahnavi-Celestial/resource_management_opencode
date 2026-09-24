import type { DataSource } from 'typeorm'
import { Permission } from './permission.entity'
import { PermissionRepository } from './permission.repository'

export class PermissionService {
  constructor(private readonly dataSource: DataSource) {}

  async listPermissions(page: number, pageSize: number): Promise<{ items: Permission[]; total: number }> {
    const safePage = Math.max(1, Math.floor(page))
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)))
    return new PermissionRepository(this.dataSource.manager).list(safePage, safePageSize)
  }
}
