import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'
import { NOTIFICATION_TYPES, type NotificationType } from '@resource-booking/shared'
import { Employee } from '../employee/employee.entity'
import { Booking } from '../booking/booking.entity'

@Index('uq_notification_booking_recipient_type', ['bookingId', 'recipientId', 'type'], { unique: true })
@Index('idx_notification_recipient_id', ['recipientId'])
@Entity('notification')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'recipient_id', type: 'uuid' })
  recipientId!: string

  @ManyToOne(() => Employee, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipient_id', foreignKeyConstraintName: 'fk_notification_recipient_id' })
  recipient!: Employee

  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId!: string

  @ManyToOne(() => Booking, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booking_id', foreignKeyConstraintName: 'fk_notification_booking_id' })
  booking!: Booking

  @Column({ name: 'type', type: 'enum', enum: [...NOTIFICATION_TYPES], enumName: 'notification_type' })
  type!: NotificationType

  @Column({ name: 'title', type: 'text' })
  title!: string

  @Column({ name: 'message', type: 'text' })
  message!: string

  @Column({ name: 'is_read', type: 'boolean', default: false })
  isRead!: boolean

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
