import type { DataSource } from 'typeorm'
import { isUniqueViolation } from '../../common/db/pg-error'
import { NotFoundError } from '../../common/errors/not-found-error'
import { Equipment } from './equipment.entity'
import type { CreateEquipmentInput, EquipmentListArgs, UpdateEquipmentInput } from './equipment.inputs'
import { EquipmentRepository } from './equipment.repository'

const EQUIPMENT_NAME_UNIQUE_CONSTRAINT = 'uq_equipment_name'

export class EquipmentService {
  private readonly repository: EquipmentRepository

  constructor(private readonly dataSource: DataSource) {
    this.repository = new EquipmentRepository(dataSource.manager)
  }

  async create(input: CreateEquipmentInput): Promise<Equipment> {
    const name = input.name.trim()
    const isActive = input.isActive ?? true
    const existing = await this.repository.findByName(name)
    if (existing !== null) {
      existing.quantityAvailable += input.quantityAvailable
      existing.isActive = isActive
      try {
        return await this.repository.save(existing)
      } catch (error: unknown) {
        if (isUniqueViolation(error, EQUIPMENT_NAME_UNIQUE_CONSTRAINT)) {
          const latest = await this.repository.findByName(name)
          if (latest !== null) {
            latest.quantityAvailable += input.quantityAvailable
            latest.isActive = isActive
            return this.repository.save(latest)
          }
        }
        throw error
      }
    }
    try {
      return await this.repository.insert({ name, quantityAvailable: input.quantityAvailable, isActive })
    } catch (error: unknown) {
      if (isUniqueViolation(error, EQUIPMENT_NAME_UNIQUE_CONSTRAINT)) {
        const latest = await this.repository.findByName(name)
        if (latest !== null) {
          latest.quantityAvailable += input.quantityAvailable
          latest.isActive = isActive
          return this.repository.save(latest)
        }
      }
      throw error
    }
  }

  async update(input: UpdateEquipmentInput): Promise<Equipment> {
    const equipment = await this.repository.findById(input.id)
    if (equipment === null) throw new NotFoundError('Equipment not found')

    if (input.name !== undefined) equipment.name = input.name.trim()
    if (input.quantityAvailable !== undefined) equipment.quantityAvailable = input.quantityAvailable
    if (input.isActive !== undefined) equipment.isActive = input.isActive

    return this.repository.save(equipment)
  }

  async list(args: EquipmentListArgs): Promise<{ items: Equipment[]; total: number }> {
    return this.repository.list(args)
  }
}
