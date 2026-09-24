import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

export const EMAIL_OUTBOX_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const
export type EmailOutboxStatus = (typeof EMAIL_OUTBOX_STATUSES)[number]

@Index('idx_email_outbox_status_next_attempt_at', ['status', 'nextAttemptAt'])
@Entity('email_outbox')
export class EmailOutbox {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'to_email', type: 'text' })
  toEmail!: string

  @Column({ name: 'subject', type: 'text' })
  subject!: string

  @Column({ name: 'html', type: 'text' })
  html!: string

  @Column({ name: 'event_type', type: 'text' })
  eventType!: string

  @Column({ name: 'status', type: 'enum', enum: [...EMAIL_OUTBOX_STATUSES], enumName: 'email_outbox_status' })
  status!: EmailOutboxStatus

  @Column({ name: 'attempts', type: 'integer', default: 0 })
  attempts!: number

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null
}
