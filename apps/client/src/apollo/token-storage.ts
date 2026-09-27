const TOKEN_KEY = 'resource-booking.jwt'

/**
 * The JWT lives in localStorage rather than in memory so a page reload keeps the
 * session, and rather than in a cookie because the API is a plain GraphQL
 * endpoint with a bearer header (the server reads `Authorization: Bearer`).
 *
 * Storing a token in localStorage is readable by any script on the origin; that
 * is an accepted trade-off for this app's threat model (NFR-5's actual
 * enforcement point is the server, which validates the signature and expiry on
 * every request — a stolen token is only usable until it expires).
 */
export const tokenStorage = {
  get(): string | null {
    const value = window.localStorage.getItem(TOKEN_KEY)
    return value === null || value === '' ? null : value
  },
  set(token: string): void {
    window.localStorage.setItem(TOKEN_KEY, token)
  },
  clear(): void {
    window.localStorage.removeItem(TOKEN_KEY)
  },
}
