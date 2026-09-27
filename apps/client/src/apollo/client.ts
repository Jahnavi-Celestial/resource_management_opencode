import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from '@apollo/client'
import { tokenStorage } from './token-storage'

/**
 * There is deliberately no WebSocket link here. GraphQL in this app is
 * query/mutation only (FR-59): notifications are pushed over the separate
 * `ws://…/ws` gateway, which arrives in C3 as its own client module. Adding a
 * split link now would mean the app depends on a transport it never uses.
 */
const authLink = new ApolloLink((operation, forward) => {
  const token = tokenStorage.get()
  if (token !== null) {
    operation.setContext(({ headers = {} }: { headers?: Record<string, string> }) => ({
      headers: { ...headers, authorization: `Bearer ${token}` },
    }))
  }
  return forward(operation)
})

export interface CreateApolloClientOptions {
  uri: string
}

export function createApolloClient({ uri }: CreateApolloClientOptions): ApolloClient {
  const httpLink = new HttpLink({ uri })
  return new ApolloClient({
    link: authLink.concat(httpLink),
    cache: new InMemoryCache(),
  })
}

export const DEFAULT_GRAPHQL_URI = 'http://localhost:4000/graphql'

/** The app's own instance; tests build their own against a spawned server. */
export const apolloClient: ApolloClient = createApolloClient({
  uri: import.meta.env.VITE_GRAPHQL_URL ?? DEFAULT_GRAPHQL_URI,
})
