import { Field, ID, Int, ObjectType } from 'type-graphql'
import { Permission } from './permission.entity'
import { Role } from './role.entity'
import { isSystemRoleName } from './system-roles'

@ObjectType('Role')
export class RoleType {
  @Field(() => ID)
  id!: string

  @Field(() => String)
  roleName!: string

  @Field(() => Boolean)
  isSystemRole!: boolean

  @Field(() => [PermissionType])
  permissions!: PermissionType[]
}

export function toRoleType(role: Role): RoleType {
  const type = new RoleType()
  type.id = role.id
  type.roleName = role.roleName
  type.isSystemRole = isSystemRoleName(role.roleName)
  return type
}

@ObjectType('Permission')
export class PermissionType {
  @Field(() => ID)
  id!: string

  @Field(() => String)
  permissionName!: string
}

export function toPermissionType(permission: Permission): PermissionType {
  const type = new PermissionType()
  type.id = permission.id
  type.permissionName = permission.permissionName
  return type
}

@ObjectType('RolePage')
export class RolePage {
  @Field(() => [RoleType])
  items!: RoleType[]

  @Field(() => Int)
  total!: number
}

@ObjectType('PermissionPage')
export class PermissionPage {
  @Field(() => [PermissionType])
  items!: PermissionType[]

  @Field(() => Int)
  total!: number
}
