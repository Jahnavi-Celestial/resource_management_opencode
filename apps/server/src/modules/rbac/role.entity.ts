import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

// Case-insensitive unique index owned by migration
// 1790176946849-AddRoleNameUniqueCaseInsensitive (LOWER(role_name)). TypeORM's
// @Index cannot express an expression index, so `synchronize: false` keeps
// schema sync from dropping the DB index or creating a second, plain-column
// one over the same name.
@Index('uq_role_role_name', ['roleName'], { unique: true, synchronize: false })
@Entity('role')
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'role_name', type: 'text' })
  roleName!: string
}
