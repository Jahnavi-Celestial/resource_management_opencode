import { Arg, Authorized, Ctx, Mutation, Query, Resolver } from 'type-graphql'
import { AuthorisationError } from '../common/errors/authorisation-error'
import type { GraphQLContext } from '../common/graphql/context'
import { toEmployeeType } from '../modules/employee/employee.types'
import { toRoleType } from '../modules/rbac/rbac.types'
import { LoginInput } from './auth.inputs'
import { AuthService } from './auth.service'
import { MeType } from './auth.types'

@Resolver()
export class AuthResolver {
  @Mutation(() => String)
  async login(
    @Arg('input', () => LoginInput) input: LoginInput,
    @Ctx() context: GraphQLContext,
  ): Promise<string> {
    const authService = new AuthService(context.dataSource)
    return authService.login(input.email, input.password)
  }

  @Query(() => MeType)
  @Authorized()
  async me(@Ctx() context: GraphQLContext): Promise<MeType> {
    if (context.auth === null) {
      throw new AuthorisationError()
    }
    return {
      employee: toEmployeeType(context.auth.employee),
      roles: context.auth.roles.map((role) => toRoleType(role)),
      permissionKeys: Array.from(context.auth.permissionKeys).sort(),
    }
  }
}
