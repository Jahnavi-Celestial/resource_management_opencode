import path from 'node:path'
import { DataSource } from 'typeorm'
import { loadEnv } from './env'
import { Employee } from '../modules/employee/employee.entity'
import { Role } from '../modules/rbac/role.entity'
import { Permission } from '../modules/rbac/permission.entity'
import { UserRole } from '../modules/rbac/user-role.entity'
import { RolePermission } from '../modules/rbac/role-permission.entity'
import { MeetingRoom } from '../modules/room/room.entity'
import { Equipment } from '../modules/equipment/equipment.entity'
import { Booking } from '../modules/booking/booking.entity'
import { BookingEquipment } from '../modules/booking/booking-equipment.entity'
import { AuditLog } from '../modules/audit/audit-log.entity'
import { Notification } from '../modules/notification/notification.entity'
import { EmailOutbox } from '../email/email-outbox.entity'

export function createDataSource(): DataSource {
  const env = loadEnv()
  return new DataSource({
    type: 'postgres',
    host: env.db.host,
    port: env.db.port,
    username: env.db.username,
    password: env.db.password,
    database: env.db.name,
    synchronize: false,
    uuidExtension: 'pgcrypto',
    entities: [
      Employee,
      Role,
      Permission,
      UserRole,
      RolePermission,
      MeetingRoom,
      Equipment,
      Booking,
      BookingEquipment,
      AuditLog,
      Notification,
      EmailOutbox,
    ],
    migrations: [path.join(__dirname, '..', 'database', 'migrations', '*.ts')],
    logging: env.nodeEnv === 'development',
  })
}
