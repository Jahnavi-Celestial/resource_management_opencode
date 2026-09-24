import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'
import { BOOKING_STATUSES, type BookingStatus } from '@resource-booking/shared'
import { Employee } from '../employee/employee.entity'
import { Booking } from '../booking/booking.entity'

export const AUDIT_ACTIONS = ['CREATE', 'APPROVE', 'REJECT', 'CANCEL', 'COMPLETE'] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

@Index('idx_audit_log_booking_id', ['bookingId'])
@Index('idx_audit_log_performed_by', ['performedById'])
@Entity('audit_log')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId!: string

  @ManyToOne(() => Booking, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booking_id', foreignKeyConstraintName: 'fk_audit_log_booking_id' })
  booking!: Booking

  @Column({ name: 'action', type: 'enum', enum: [...AUDIT_ACTIONS], enumName: 'audit_action' })
  action!: AuditAction

  @Column({ name: 'old_status', type: 'enum', enum: [...BOOKING_STATUSES], enumName: 'booking_status', nullable: true })
  oldStatus!: BookingStatus | null

  @Column({ name: 'new_status', type: 'enum', enum: [...BOOKING_STATUSES], enumName: 'booking_status' })
  newStatus!: BookingStatus

  @Column({ name: 'performed_by', type: 'uuid', nullable: true })
  performedById!: string | null

  @ManyToOne(() => Employee, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'performed_by', foreignKeyConstraintName: 'fk_audit_log_performed_by' })
  performedBy!: Employee | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
