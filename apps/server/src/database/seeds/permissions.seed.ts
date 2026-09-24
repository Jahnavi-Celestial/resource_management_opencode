import type { DataSource } from 'typeorm'
import { PERMISSION_KEYS } from '@resource-booking/shared'
import { Permission } from '../../modules/rbac/permission.entity'

export async function seedPermissions(dataSource: DataSource): Promise<void> {
  const repository = dataSource.getRepository(Permission)
  const existing = await repository.find()
  const existingNames = new Set(existing.map((permission) => permission.permissionName))
  const missing = PERMISSION_KEYS.filter((permissionName) => !existingNames.has(permissionName))

  if (missing.length > 0) {
    await repository
      .createQueryBuilder()
      .insert()
      .values(missing.map((permissionName) => ({ permissionName })))
      .orIgnore()
      .execute()
  }

  console.log(
    `permissions: inserted ${missing.length}, already present ${existing.length} (catalogue size ${PERMISSION_KEYS.length})`,
  )
}
