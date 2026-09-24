import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'
import { Permission } from './permission.entity'
import { Role } from './role.entity'

@Index('uq_role_permission_role_id_permission_id', ['roleId', 'permissionId'], { unique: true })
@Index('idx_role_permission_permission_id', ['permissionId'])
@Entity('role_permission')
export class RolePermission {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'role_id', type: 'uuid' })
  roleId!: string

  @ManyToOne(() => Role, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id', foreignKeyConstraintName: 'fk_role_permission_role_id' })
  role!: Role

  @Column({ name: 'permission_id', type: 'uuid' })
  permissionId!: string

  @ManyToOne(() => Permission, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'permission_id', foreignKeyConstraintName: 'fk_role_permission_permission_id' })
  permission!: Permission
}
