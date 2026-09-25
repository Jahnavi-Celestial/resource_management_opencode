import DataLoader from 'dataloader'
import type { DataSource } from 'typeorm'
import { In } from 'typeorm'
import { Employee } from '../modules/employee/employee.entity'

export const DELETED_USER_DISPLAY_NAME = 'Deleted user'

export function employeeDisplayName(employee: Employee | null | undefined): string {
  if (!employee) {
    return DELETED_USER_DISPLAY_NAME
  }
  const name = `${employee.firstName} ${employee.lastName}`.trim()
  return name || DELETED_USER_DISPLAY_NAME
}

export function createEmployeeLoader(dataSource: DataSource): DataLoader<string, Employee | null> {
  return new DataLoader<string, Employee | null>(async (ids: readonly string[]) => {
    const employees = await dataSource.getRepository(Employee).find({ where: { id: In([...ids]) } })
    const byId = new Map(employees.map((employee) => [employee.id, employee]))
    return ids.map((id) => byId.get(id) ?? null)
  })
}

export async function loadEmployee(
  id: string | null | undefined,
  loader: DataLoader<string, Employee | null>,
): Promise<Employee | null> {
  return id === null || id === undefined ? null : loader.load(id)
}
