export const PERMISSION_KEYS = [
  'employee:read',
  'employee:write',
  'role:read',
  'role:write',
  'role:assign',
  'permission:read',
  'room:read',
  'room:write',
  'equipment:read',
  'equipment:write',
  'booking:create',
  'booking:read:own',
  'booking:read:all',
  'booking:approve',
  'booking:reject',
  'booking:cancel:own',
  'booking:cancel:any',
  'audit:read',
  'report:read',
] as const

export type PermissionKey = (typeof PERMISSION_KEYS)[number]
