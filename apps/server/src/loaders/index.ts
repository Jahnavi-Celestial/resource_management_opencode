import type DataLoader from 'dataloader'
import type { DataSource } from 'typeorm'
import type { AuditLog } from '../modules/audit/audit-log.entity'
import type { Employee } from '../modules/employee/employee.entity'
import type { Permission } from '../modules/rbac/permission.entity'
import type { Role } from '../modules/rbac/role.entity'
import type { BookingEquipment } from '../modules/booking/booking-equipment.entity'
import type { EquipmentAvailabilityWindow } from '../modules/booking/availability'
import type { MeetingRoom } from '../modules/room/room.entity'
import {
  createBookingEquipmentLinesLoader,
  createBookingRoomLoader,
  createBookingStatusHistoryLoader,
  createEquipmentAvailabilityLoader,
  createOverlappingRoomBookingsLoader,
  createRecentEmployeeBookingsLoader,
  type BookingSummaryData,
  type OverlappingRoomBookingsKey,
  type RecentEmployeeBookingsKey,
} from './booking-detail.loader'
import { createEmployeeLoader } from './employee.loader'
import { createEmployeeRolesLoader } from './employee-roles.loader'
import { createLatestProcessingAuditLoader } from './latest-processing-audit.loader'
import { createRolePermissionsLoader } from './role-permissions.loader'

export interface Loaders {
  bookingEquipmentLines: DataLoader<string, BookingEquipment[]>
  bookingRoom: DataLoader<string, MeetingRoom | null>
  bookingStatusHistory: DataLoader<string, AuditLog[]>
  employee: DataLoader<string, Employee | null>
  employeeRoles: DataLoader<string, Role[]>
  equipmentAvailability: DataLoader<EquipmentAvailabilityWindow, number>
  latestProcessingAudit: DataLoader<string, AuditLog | null>
  overlappingRoomBookings: DataLoader<OverlappingRoomBookingsKey, BookingSummaryData[]>
  recentEmployeeBookings: DataLoader<RecentEmployeeBookingsKey, BookingSummaryData[]>
  rolePermissions: DataLoader<string, Permission[]>
}

export function createLoaders(dataSource: DataSource): Loaders {
  return {
    bookingEquipmentLines: createBookingEquipmentLinesLoader(dataSource),
    bookingRoom: createBookingRoomLoader(dataSource),
    bookingStatusHistory: createBookingStatusHistoryLoader(dataSource),
    employee: createEmployeeLoader(dataSource),
    employeeRoles: createEmployeeRolesLoader(dataSource),
    equipmentAvailability: createEquipmentAvailabilityLoader(dataSource),
    latestProcessingAudit: createLatestProcessingAuditLoader(dataSource),
    overlappingRoomBookings: createOverlappingRoomBookingsLoader(dataSource),
    recentEmployeeBookings: createRecentEmployeeBookingsLoader(dataSource),
    rolePermissions: createRolePermissionsLoader(dataSource),
  }
}
