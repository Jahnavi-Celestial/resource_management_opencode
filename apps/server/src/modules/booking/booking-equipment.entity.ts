import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'
import { Equipment } from '../equipment/equipment.entity'
import { Booking } from './booking.entity'

@Check('chk_booking_equipment_quantity_positive', '"quantity" > 0')
@Index('uq_booking_equipment_booking_id_equipment_id', ['bookingId', 'equipmentId'], { unique: true })
@Index('idx_booking_equipment_equipment_id', ['equipmentId'])
@Entity('booking_equipment')
export class BookingEquipment {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId!: string

  @ManyToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'booking_id', foreignKeyConstraintName: 'fk_booking_equipment_booking_id' })
  booking!: Booking

  @Column({ name: 'equipment_id', type: 'uuid' })
  equipmentId!: string

  @ManyToOne(() => Equipment, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'equipment_id', foreignKeyConstraintName: 'fk_booking_equipment_equipment_id' })
  equipment!: Equipment

  @Column({ name: 'quantity', type: 'integer' })
  quantity!: number
}
