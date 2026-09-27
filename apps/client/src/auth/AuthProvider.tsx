import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useApolloClient, useMutation, useQuery } from '@apollo/client/react'
import type { MeQuery } from '@/graphql/graphql'
import { tokenStorage } from '@/apollo/token-storage'
import { LoginDocument } from '@/features/auth/graphql/login.mutation'
import { MeDocument } from '@/features/auth/graphql/me.query'
import { toPermissionSet, type PermissionKey, type PermissionSet } from './permissions'

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

export interface Session {
  employee: MeQuery['me']['employee']
  roles: MeQuery['me']['roles']
  permissionKeys: PermissionKey[]
}

interface AuthContextValue {
  status: AuthStatus
  session: Session | null
  permissions: PermissionSet
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const client = useApolloClient()
  // The token is mirrored into state (not read from storage on every render) so
  // that setting or clearing it is what re-triggers the `me` query below.
  const [token, setToken] = useState<string | null>(() => tokenStorage.get())
  const [loginMutation] = useMutation(LoginDocument)

  const { data, error } = useQuery(MeDocument, {
    skip: token === null,
    fetchPolicy: 'cache-and-network',
  })

  const me = data?.me ?? null

  // A token the server rejects (expired, revoked, signed with another secret) is
  // not a session: drop it so the app falls back to the login page instead of
  // retrying a request that can only fail. NFR-5 — the server is the enforcement
  // point; this is only the client agreeing with it.
  useEffect(() => {
    if (error !== undefined && token !== null) {
      tokenStorage.clear()
      setToken(null)
    }
  }, [error, token])

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      const result = await loginMutation({ variables: { input: { email, password } } })
      const issued = result.data?.login
      if (issued === undefined || issued === '') {
        throw new Error('login returned no token')
      }
      // Clear the normalised cache *before* the new identity becomes the
      // current one: otherwise the previous user's `me` (and any other cached
      // result) would be readable for one render under the new token.
      await client.clearStore()
      tokenStorage.set(issued)
      setToken(issued)
    },
    [client, loginMutation],
  )

  const logout = useCallback(async (): Promise<void> => {
    await client.clearStore()
    tokenStorage.clear()
    setToken(null)
  }, [client])

  const value = useMemo<AuthContextValue>(() => {
    const permissions = toPermissionSet(me?.permissionKeys)
    // A token with no profile yet is still "loading": the `me` request is in
    // flight. A token the server refused is turned into `anonymous` by the
    // effect above, so this never has to represent a third failure mode.
    const status: AuthStatus = token === null ? 'anonymous' : me === null ? 'loading' : 'authenticated'
    return {
      status,
      session:
        me === null
          ? null
          : {
              employee: me.employee,
              roles: me.roles,
              permissionKeys: me.permissionKeys as PermissionKey[],
            },
      permissions,
      login,
      logout,
    }
  }, [login, logout, me, token])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (value === null) {
    throw new Error('useAuth must be used inside <AuthProvider>')
  }
  return value
}
