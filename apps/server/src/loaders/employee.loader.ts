import DataLoader from 'dataloader'
import type { DataSource } from 'typeorm'
import { In } from 'typeorm'
import { Employee } from '../modules/employee/employee.entity'

export function createEmployeeLoader(dataSource: DataSource): DataLoader<string, Employee | null> {
  return new DataLoader<string, Employee | null>(async (ids: readonly string[]) => {
    const employees = await dataSource.getRepository(Employee).find({ where: { id: In([...ids]) } })
    const byId = new Map(employees.map((employee) => [employee.id, employee]))
    return ids.map((id) => byId.get(id) ?? null)
  })
}
