import type { EntityManager } from 'typeorm'
import { isUuid } from '../../common/db/uuid'
import { applyPagination } from '../../common/pagination/apply-pagination'
import type { SortableFields } from '../../common/pagination/sort-input'
import { Equipment } from './equipment.entity'
import type { EquipmentListArgs } from './equipment.inputs'

export const EQUIPMENT_SORTABLE_FIELDS: SortableFields = {
  name: 'equipment.name',
  quantityAvailable: 'equipment.quantity_available',
  isActive: 'equipment.is_active',
  createdAt: 'equipment.created_at',
  updatedAt: 'equipment.updated_at',
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}

export class EquipmentRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Equipment | null> {
    if (!isUuid(id)) return null
    return this.em.getRepository(Equipment).findOne({ where: { id } })
  }

  async insert(data: { name: string; quantityAvailable: number }): Promise<Equipment> {
    const equipment = new Equipment()
    equipment.name = data.name
    equipment.quantityAvailable = data.quantityAvailable
    return this.em.getRepository(Equipment).save(equipment)
  }

  async save(equipment: Equipment): Promise<Equipment> {
    return this.em.getRepository(Equipment).save(equipment)
  }

  async list(args: EquipmentListArgs): Promise<{ items: Equipment[]; total: number }> {
    const qb = this.em.getRepository(Equipment).createQueryBuilder('equipment')
    const search = args.search?.trim()
    if (search !== undefined && search !== '') {
      const pattern = `%${escapeLike(search)}%`
      qb.andWhere('equipment.name ILIKE :pattern', { pattern })
    }
    if (args.activeOnly) {
      qb.andWhere('equipment.is_active = true')
    }
    applyPagination(qb, args, args.sort, EQUIPMENT_SORTABLE_FIELDS)
    if (args.sort === undefined || args.sort === null) {
      qb.orderBy('equipment.name', 'ASC')
    }
    qb.addOrderBy('equipment.id', 'ASC')
    const [items, total] = await qb.getManyAndCount()
    return { items, total }
  }
}
