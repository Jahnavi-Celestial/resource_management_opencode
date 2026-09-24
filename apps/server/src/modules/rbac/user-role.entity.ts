import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'
import { Employee } from '../employee/employee.entity'
import { Role } from './role.entity'

@Index('uq_user_role_employee_id_role_id', ['employeeId', 'roleId'], { unique: true })
@Index('idx_user_role_role_id', ['roleId'])
@Entity('user_role')
export class UserRole {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'employee_id', type: 'uuid' })
  employeeId!: string

  @ManyToOne(() => Employee, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employee_id', foreignKeyConstraintName: 'fk_user_role_employee_id' })
  employee!: Employee

  @Column({ name: 'role_id', type: 'uuid' })
  roleId!: string

  @ManyToOne(() => Role, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id', foreignKeyConstraintName: 'fk_user_role_role_id' })
  role!: Role
}
