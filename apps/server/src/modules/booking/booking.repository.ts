import type { EntityManager } from 'typeorm'
import { Booking } from './booking.entity'
import { BookingEquipment } from './booking-equipment.entity'
import { Equipment } from '../equipment/equipment.entity'
import { MeetingRoom } from '../room/room.entity'

type BookingResourceLock =
  | { kind: 'room'; id: string }
  | { kind: 'equipment'; id: string }

export type InsertBookingData = {
  employeeId: string | null
  roomId: string
  startTime: Date
  endTime: Date
  purpose: string
  numberOfAttendees: number
}

export type InsertBookingEquipmentData = {
  equipmentId: string
  quantity: number
}

export class BookingRepository {
  async lockResources(
    manager: EntityManager,
    roomId: string,
    equipmentIds: readonly string[],
  ): Promise<void> {
    const resources = new Map<string, BookingResourceLock>()
    resources.set(`room:${roomId}`, { kind: 'room', id: roomId })

    for (const equipmentId of equipmentIds) {
      resources.set(`equipment:${equipmentId}`, { kind: 'equipment', id: equipmentId })
    }

    const sortedResources = [...resources.values()].sort((left, right) => {
      if (left.id !== right.id) {
        return left.id < right.id ? -1 : 1
      }
      return left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0
    })

    for (const resource of sortedResources) {
      if (resource.kind === 'room') {
        await manager
          .getRepository(MeetingRoom)
          .createQueryBuilder('room')
          .select('room.id')
          .where('room.id = :id', { id: resource.id })
          .orderBy('room.id', 'ASC')
          .setLock('pessimistic_write')
          .getOne()
      } else {
        await manager
          .getRepository(Equipment)
          .createQueryBuilder('equipment')
          .select('equipment.id')
          .where('equipment.id = :id', { id: resource.id })
          .orderBy('equipment.id', 'ASC')
          .setLock('pessimistic_write')
          .getOne()
      }
    }
  }

  async findRoom(manager: EntityManager, roomId: string): Promise<MeetingRoom | null> {
    return manager.getRepository(MeetingRoom).findOne({ where: { id: roomId } })
  }

  async insert(manager: EntityManager, data: InsertBookingData): Promise<Booking> {
    const repository = manager.getRepository(Booking)
    return repository.save(
      repository.create({
        ...data,
        rejectionReason: null,
        status: 'PENDING',
      }),
    )
  }

  async insertEquipment(
    manager: EntityManager,
    bookingId: string,
    items: readonly InsertBookingEquipmentData[],
  ): Promise<BookingEquipment[]> {
    if (items.length === 0) {
      return []
    }

    const repository = manager.getRepository(BookingEquipment)
    return repository.save(
      items.map((item) =>
        repository.create({
          bookingId,
          equipmentId: item.equipmentId,
          quantity: item.quantity,
        }),
      ),
    )
  }
}
