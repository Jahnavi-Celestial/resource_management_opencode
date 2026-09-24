import type { DataSource } from 'typeorm'
import { NotFoundError } from '../../common/errors/not-found-error'
import { Equipment } from './equipment.entity'
import type { CreateEquipmentInput, EquipmentListArgs, UpdateEquipmentInput } from './equipment.inputs'
import { EquipmentRepository } from './equipment.repository'

export class EquipmentService {
  private readonly repository: EquipmentRepository

  constructor(private readonly dataSource: DataSource) {
    this.repository = new EquipmentRepository(dataSource.manager)
  }

  async create(input: CreateEquipmentInput): Promise<Equipment> {
    return this.repository.insert({
      name: input.name.trim(),
      quantityAvailable: input.quantityAvailable,
    })
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
