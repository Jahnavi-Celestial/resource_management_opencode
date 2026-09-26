import type { EntityManager } from 'typeorm'
import { Booking } from './booking.entity'
import { BookingEquipment } from './booking-equipment.entity'
import { Equipment } from '../equipment/equipment.entity'

const ACTIVE_BOOKING_STATUSES = ['PENDING', 'APPROVED'] as const

export type EquipmentAvailabilityWindow = {
  equipmentId: string
  startTime: Date
  endTime: Date
}

export function equipmentAvailabilityKey(window: EquipmentAvailabilityWindow): string {
  return `${window.equipmentId.toLowerCase()}:${window.startTime.toISOString()}:${window.endTime.toISOString()}`
}

export async function getEquipmentFreeQuantities(
  manager: EntityManager,
  windows: readonly EquipmentAvailabilityWindow[],
  excludeBookingId?: string,
): Promise<Map<string, number>> {
  const uniqueWindows = new Map<string, EquipmentAvailabilityWindow>()
  for (const window of windows) {
    const normalizedWindow = {
      ...window,
      equipmentId: window.equipmentId.toLowerCase(),
    }
    uniqueWindows.set(equipmentAvailabilityKey(normalizedWindow), normalizedWindow)
  }
  const result = new Map<string, number>()
  if (uniqueWindows.size === 0) {
    return result
  }

  const equipmentIds = [...new Set([...uniqueWindows.values()].map((window) => window.equipmentId))]
  const equipmentRows = await manager
    .getRepository(Equipment)
    .createQueryBuilder('equipment')
    .select('equipment.id', 'id')
    .addSelect('equipment.quantity_available', 'quantityAvailable')
    .where('equipment.id IN (:...equipmentIds)', { equipmentIds })
    .getRawMany<{ id: string; quantityAvailable: string | number }>()
  const quantities = new Map(
    equipmentRows.map((equipment) => [equipment.id, Number(equipment.quantityAvailable)]),
  )
  for (const key of uniqueWindows.keys()) {
    const window = uniqueWindows.get(key)
    result.set(key, window === undefined ? 0 : (quantities.get(window.equipmentId) ?? 0))
  }

  const windowsList = [...uniqueWindows.values()]
  const parameters: Record<string, string | Date> = {}
  const conditions = windowsList.map((window, index) => {
    parameters[`availabilityEquipmentId${index}`] = window.equipmentId
    parameters[`availabilityEndTime${index}`] = window.endTime
    parameters[`availabilityStartTime${index}`] = window.startTime
    return `(
      bookingEquipment.equipmentId = :availabilityEquipmentId${index}
      AND booking.startTime < :availabilityEndTime${index}
      AND booking.endTime > :availabilityStartTime${index}
    )`
  })
  const aggregateQuery = manager
    .getRepository(BookingEquipment)
    .createQueryBuilder('bookingEquipment')
    .innerJoin('bookingEquipment.booking', 'booking')
    .select('1', 'rowMarker')
  windowsList.forEach((_window, index) => {
    aggregateQuery.addSelect(
      `COALESCE(SUM(CASE WHEN ${conditions[index]} THEN bookingEquipment.quantity ELSE 0 END), 0)`,
      `committed${index}`,
    )
  })
  const query = aggregateQuery
    .where(`(${conditions.join(' OR ')})`, parameters)
    .andWhere('booking.status IN (:...activeStatuses)', {
      activeStatuses: [...ACTIVE_BOOKING_STATUSES],
    })
  if (excludeBookingId !== undefined) {
    query.andWhere('booking.id != :excludeBookingId', { excludeBookingId })
  }
  const aggregate = await query.getRawOne<Record<string, string | number>>()

  windowsList.forEach((window, index) => {
    const key = equipmentAvailabilityKey(window)
    result.set(key, (result.get(key) ?? 0) - Number(aggregate?.[`committed${index}`] ?? 0))
  })
  return result
}

export async function getEquipmentFreeQuantity(
  manager: EntityManager,
  equipmentId: string,
  startTime: Date,
  endTime: Date,
  excludeBookingId?: string,
): Promise<number> {
  const window = { equipmentId, startTime, endTime }
  const quantities = await getEquipmentFreeQuantities(manager, [window], excludeBookingId)
  return quantities.get(equipmentAvailabilityKey(window)) ?? 0
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
