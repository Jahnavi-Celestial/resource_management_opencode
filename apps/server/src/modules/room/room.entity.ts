import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

// Case-insensitive unique index owned by migration
// 1790176946847-AddRoomNameLocationUniqueCaseInsensitive (LOWER(name),
// LOWER(location)). TypeORM's @Index cannot express an expression index, so
// `synchronize: false` keeps schema sync from dropping the DB index or
// creating a second, plain-column one over the same name.
@Index('uq_room_name_location', ['name', 'location'], { unique: true, synchronize: false })
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
