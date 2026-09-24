import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

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
