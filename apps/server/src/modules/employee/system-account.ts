export const SYSTEM_EMPLOYEE_EMAIL = 'system@internal.local'

export function isSystemEmployeeEmail(email: string): boolean {
  return email === SYSTEM_EMPLOYEE_EMAIL
}
