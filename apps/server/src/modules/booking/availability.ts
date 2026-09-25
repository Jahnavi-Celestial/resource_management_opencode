import type { EntityManager } from 'typeorm'
import { Booking } from './booking.entity'
import { BookingEquipment } from './booking-equipment.entity'
import { Equipment } from '../equipment/equipment.entity'

const ACTIVE_BOOKING_STATUSES = ['PENDING', 'APPROVED'] as const

export async function getEquipmentFreeQuantity(
  manager: EntityManager,
  equipmentId: string,
  startTime: Date,
  endTime: Date,
): Promise<number> {
  const equipment = await manager
    .getRepository(Equipment)
    .findOne({ where: { id: equipmentId }, select: ['quantityAvailable'] })

  if (!equipment) {
    return 0
  }

  const aggregate = await manager
    .getRepository(BookingEquipment)
    .createQueryBuilder('bookingEquipment')
    .innerJoin('bookingEquipment.booking', 'booking')
    .select('COALESCE(SUM(bookingEquipment.quantity), 0)', 'committed')
    .where('bookingEquipment.equipmentId = :equipmentId', { equipmentId })
    .andWhere('booking.status IN (:...activeStatuses)', {
      activeStatuses: [...ACTIVE_BOOKING_STATUSES],
    })
    .andWhere('booking.startTime < :endTime', { endTime })
    .andWhere('booking.endTime > :startTime', { startTime })
    .getRawOne<{ committed: string | number }>()

  return equipment.quantityAvailable - Number(aggregate?.committed ?? 0)
}

export async function isRoomAvailable(
  manager: EntityManager,
  roomId: string,
  startTime: Date,
  endTime: Date,
  excludeBookingId?: string,
): Promise<boolean> {
  const query = manager
    .getRepository(Booking)
    .createQueryBuilder('booking')
    .where('booking.roomId = :roomId', { roomId })
    .andWhere('booking.status IN (:...activeStatuses)', {
      activeStatuses: [...ACTIVE_BOOKING_STATUSES],
    })
    .andWhere('booking.startTime < :endTime', { endTime })
    .andWhere('booking.endTime > :startTime', { startTime })

  if (excludeBookingId !== undefined) {
    query.andWhere('booking.id != :excludeBookingId', { excludeBookingId })
  }

  return (await query.getCount()) === 0
}
