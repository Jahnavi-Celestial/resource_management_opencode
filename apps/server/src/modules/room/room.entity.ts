import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

@Entity('meeting_room')
export class MeetingRoom {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'name', type: 'text' })
  name!: string

  @Column({ name: 'location', type: 'text' })
  location!: string

  @Column({ name: 'capacity', type: 'integer' })
  capacity!: number

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
