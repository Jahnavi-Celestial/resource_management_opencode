import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Index('uq_permission_permission_name', ['permissionName'], { unique: true })
@Entity('permission')
export class Permission {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'permission_name', type: 'text' })
  permissionName!: string
}
