import type { EntityManager } from 'typeorm'
import { isUuid } from '../../common/db/uuid'
import { applyPagination } from '../../common/pagination/apply-pagination'
import type { SortableFields } from '../../common/pagination/sort-input'
import { MeetingRoom } from './room.entity'
import type { RoomListArgs } from './room.inputs'

export const ROOM_SORTABLE_FIELDS: SortableFields = {
  name: 'room.name',
  location: 'room.location',
  capacity: 'room.capacity',
  isActive: 'room.is_active',
  createdAt: 'room.created_at',
  updatedAt: 'room.updated_at',
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}

export class RoomRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<MeetingRoom | null> {
    if (!isUuid(id)) return null
    return this.em.getRepository(MeetingRoom).findOne({ where: { id } })
  }

  async insert(data: { name: string; location: string; capacity: number }): Promise<MeetingRoom> {
    const room = new MeetingRoom()
    room.name = data.name
    room.location = data.location
    room.capacity = data.capacity
    return this.em.getRepository(MeetingRoom).save(room)
  }

  async save(room: MeetingRoom): Promise<MeetingRoom> {
    return this.em.getRepository(MeetingRoom).save(room)
  }

  async list(args: RoomListArgs): Promise<{ items: MeetingRoom[]; total: number }> {
    const qb = this.em.getRepository(MeetingRoom).createQueryBuilder('room')
    const search = args.search?.trim()
    if (search !== undefined && search !== '') {
      const pattern = `%${escapeLike(search)}%`
      qb.andWhere('(room.name ILIKE :pattern OR room.location ILIKE :pattern)', { pattern })
    }
    if (args.minCapacity !== undefined && args.minCapacity !== null) {
      qb.andWhere('room.capacity >= :minCapacity', { minCapacity: args.minCapacity })
    }
    if (args.maxCapacity !== undefined && args.maxCapacity !== null) {
      qb.andWhere('room.capacity <= :maxCapacity', { maxCapacity: args.maxCapacity })
    }
    if (args.activeOnly) {
      qb.andWhere('room.is_active = true')
    }
    applyPagination(qb, args, args.sort, ROOM_SORTABLE_FIELDS)
    if (args.sort === undefined || args.sort === null) {
      qb.orderBy('room.name', 'ASC')
    }
    qb.addOrderBy('room.id', 'ASC')
    const [items, total] = await qb.getManyAndCount()
    return { items, total }
  }
}
