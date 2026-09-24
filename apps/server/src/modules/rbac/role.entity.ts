import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Index('uq_role_role_name', ['roleName'], { unique: true })
@Entity('role')
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'role_name', type: 'text' })
  roleName!: string
}
