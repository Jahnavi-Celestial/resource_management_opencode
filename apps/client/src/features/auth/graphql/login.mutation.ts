import { graphql } from '@/graphql'

/**
 * C0 only needs the token, so the mutation selects nothing: `login` returns a
 * bare `String!`. The profile itself is read separately by the `me` query, so
 * a successful login and a populated session are two independently observable
 * steps (and the token is stored before the profile request is made).
 */
export const LoginDocument = graphql(/* GraphQL */ `
  mutation Login($input: LoginInput!) {
    login(input: $input)
  }
`)
