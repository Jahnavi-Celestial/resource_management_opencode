import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Exclusion,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'
import { BOOKING_STATUSES, type BookingStatus } from '@resource-booking/shared'
import { Employee } from '../employee/employee.entity'
import { MeetingRoom } from '../room/room.entity'

@Check('chk_booking_end_after_start', '"end_time" > "start_time"')
@Check('chk_booking_number_of_attendees_positive', '"number_of_attendees" > 0')
@Exclusion(
  'ex_booking_room_time_range',
  "USING gist (\"room_id\" WITH = AND tstzrange(\"start_time\", \"end_time\", '[)') WITH &&) WHERE (\"status\" IN ('PENDING', 'APPROVED'))",
)
@Index('idx_booking_start_time_end_time', ['startTime', 'endTime'])
@Index('idx_booking_status', ['status'])
@Index('idx_booking_employee_id', ['employeeId'])
@Index('idx_booking_room_id', ['roomId'])
@Entity('booking')
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'employee_id', type: 'uuid', nullable: true })
  employeeId!: string | null

  @ManyToOne(() => Employee, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'employee_id', foreignKeyConstraintName: 'fk_booking_employee_id' })
  employee!: Employee | null

  @Column({ name: 'room_id', type: 'uuid' })
  roomId!: string

  @ManyToOne(() => MeetingRoom, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'room_id', foreignKeyConstraintName: 'fk_booking_room_id' })
  room!: MeetingRoom

  @Column({ name: 'start_time', type: 'timestamptz' })
  startTime!: Date

  @Column({ name: 'end_time', type: 'timestamptz' })
  endTime!: Date

  @Column({ name: 'purpose', type: 'text' })
  purpose!: string

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason!: string | null

  @Column({ name: 'number_of_attendees', type: 'integer' })
  numberOfAttendees!: number

  @Column({ name: 'status', type: 'enum', enum: [...BOOKING_STATUSES], enumName: 'booking_status' })
  status!: BookingStatus

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
