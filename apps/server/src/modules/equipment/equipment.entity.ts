import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

// Case-insensitive unique index owned by migration
// 1790176946848-AddEquipmentNameUniqueCaseInsensitive (LOWER(name)). TypeORM's
// @Index cannot express an expression index, so `synchronize: false` keeps
// schema sync from dropping the DB index or creating a second, plain-column
// one over the same name.
@Index('uq_equipment_name', ['name'], { unique: true, synchronize: false })
@Entity('equipment')
export class Equipment {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'name', type: 'text' })
  name!: string

  @Column({ name: 'quantity_available', type: 'integer' })
  quantityAvailable!: number

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
