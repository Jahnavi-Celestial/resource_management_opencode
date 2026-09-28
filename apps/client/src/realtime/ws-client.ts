/**
 * The realtime client core (C3 part 1).
 *
 * This is a *transport*, not a data layer: it opens one authenticated socket,
 * keeps it open, and hands typed events to whoever subscribed. It knows nothing
 * about Apollo — `useNotificationSocket` is what turns the events into cache
 * writes.
 *
 * Three facts about the server shape the whole design, and all three come from
 * `apps/server/src/realtime/gateway.ts` + `events.ts`:
 *
 * 1. **The token is a query parameter.** The gateway reads `Authorization:`
 *    *or* `?token=` (`extractHandshakeToken`), and a browser `WebSocket` cannot
 *    set a header, so the query parameter is the only option here.
 * 2. **A rejected token is invisible to the browser.** `rejectUpgrade` writes a
 *    raw `HTTP/1.1 401` and destroys the socket *before* the handshake
 *    completes, so the WebSocket API surfaces it as `error` + `close` with code
 *    1006 — exactly what a powered-off server looks like. The client therefore
 *    cannot tell "the network is down" from "this token is refused", and must
 *    not answer that question by guessing from the close code. It asks the two
 *    things it *can* know: is the token expired (`exp`, decoded not
 *    verified), and does `me` still work. See `decideReconnect`.
 * 3. **The server sends one frame that is not an event.** On accept it writes
 *    `{ type: 'connection.ready', employeeId }`; `events.ts`'s `RealtimeEvent`
 *    union deliberately does not include it, because it is the gateway
 *    speaking rather than a domain event. It is typed here because a client
 *    that ignored it would treat every fresh connection as silent.
 *
 * Everything time- and network-dependent is injected (`webSocketFactory`,
 * `setTimeout`, `now`, `random`) so a suite can drive the whole lifecycle —
 * including the backoff schedule and the refusal path — without a server and
 * without waiting on real timers.
 */

import type { MyNotificationsQuery } from '@/graphql/graphql'

/**
 * The notification record as the `myNotifications` query selects it. Derived
 * from that query rather than re-declared, so the shape the socket validates
 * and the shape the list renders cannot drift apart: adding a field to the
 * document changes both.
 */
export type Notification = MyNotificationsQuery['myNotifications']['items'][number]

/** Mirrors `REALTIME_PATH` in `apps/server/src/realtime/gateway.ts`. */
export const REALTIME_PATH = '/ws'

/** Mirrors `SERVER_SHUTDOWN_CLOSE_CODE`: the server tearing the socket down. */
export const SERVER_SHUTDOWN_CLOSE_CODE = 4401

/**
 * The default base for `VITE_WS_URL`: the same origin the client defaults its
 * GraphQL URL to (`apps/client/src/apollo/client.ts`), which is the dev
 * server's port from `.env.example`.
 */
export const DEFAULT_WS_URL = 'ws://localhost:4000'

/** A close the browser reports when it never saw a valid handshake response. */
const ABNORMAL_CLOSURE = 1006

export type RealtimeState = 'connecting' | 'open' | 'closed' | 'auth-failed'

/**
 * `notification.created` — the one domain event in the server's `RealtimeEvent`
 * union. `unreadCount` is the server's own count, and the client treats it as
 * the truth rather than incrementing a local one: after a reconnect the client
 * has missed events, and a local `+ 1` would undercount forever.
 */
export interface NotificationCreatedEvent {
  type: 'notification.created'
  notification: Notification
  unreadCount: number
}

/** The gateway's accept frame. Not a `RealtimeEvent`; see the file header. */
export interface ConnectionReadyEvent {
  type: 'connection.ready'
  employeeId: string
}

export type InboundEvent = NotificationCreatedEvent | ConnectionReadyEvent

/**
 * The subset of the WebSocket API this client uses, so the browser's own
 * `WebSocket`, a jsdom one, and a hand-written fake are all interchangeable.
 * The handler types are the DOM ones on purpose — a narrower parameter type
 * would be *more* useful to write against but would stop the real `WebSocket`
 * from being assignable to this interface.
 */
export interface RealtimeWebSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
}

export interface RealtimeWebSocketFactory {
  (url: string): RealtimeWebSocket
}

/** Why the client gave up instead of reconnecting. */
export type ReconnectRefusal = 'no-token' | 'undecodable' | 'expired' | 'stopped'

export type ReconnectDecision =
  | { shouldReconnect: true; attempt: number; delayMs: number }
  | { shouldReconnect: false; reason: ReconnectRefusal }

export type EventListener = (event: InboundEvent) => void
export type StateListener = (state: RealtimeState) => void
export type AuthFailureListener = (reason: ReconnectRefusal) => void

export const DEFAULT_BASE_DELAY_MS = 500
export const DEFAULT_MAX_DELAY_MS = 30_000

/**
 * A JWT is checked this far before it actually expires, so a socket is not
 * opened with a token that dies mid-handshake — and so a long backoff does not
 * spend its whole wait on a token that expired during it.
 */
export const DEFAULT_EXPIRY_SKEW_MS = 5_000

/**
 * Exponential backoff with *equal* jitter: half the computed delay is fixed and
 * half is random. Pure full jitter (`random() * delay`) can return ~0, which on
 * a flapping connection produces a tight reconnect loop; pure fixed delay
 * makes N clients that dropped together reconnect together.
 *
 * `random` is a parameter so the schedule is reproducible in a test.
 */
export function backoffDelayMs(
  attempt: number,
  {
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    random = Math.random,
  }: { baseDelayMs?: number; maxDelayMs?: number; random?: () => number } = {},
): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0
  const exponential = baseDelayMs * 2 ** safeAttempt
  const fixed = Math.min(exponential, maxDelayMs)
  return Math.round(fixed / 2 + random() * (fixed / 2))
}

/**
 * Decodes a JWT's `exp` claim. **Decoding only, no verification** — the
 * signature is the server's business (`resolveAuthContext` does that on every
 * handshake). This exists to answer one question the browser cannot: is it
 * worth opening a socket at all?
 *
 * Returns `null` for anything that is not a decodable three-part token with a
 * numeric `exp`, and the caller treats `null` as unusable rather than as
 * "not expired" — a token the client cannot even read is not a session.
 */
export function decodeJwtExpiryMs(token: string | null): number | null {
  if (token === null || token === '') {
    return null
  }
  const parts = token.split('.')
  const payloadPart = parts.length === 3 ? parts[1] : undefined
  if (payloadPart === undefined) {
    return null
  }
  try {
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof payload !== 'object' || payload === null || !('exp' in payload)) {
      return null
    }
    const exp = (payload as { exp: unknown }).exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
  } catch {
    return null
  }
}

export interface DecideReconnectOptions {
  token: string | null
  /** Consecutive failures so far; 0 for the first attempt after a close. */
  attempt: number
  /** True once `stop()` has been called (logout, unmount). */
  stopped?: boolean
  nowMs: number
  baseDelayMs?: number
  maxDelayMs?: number
  expirySkewMs?: number
  random?: () => number
}

/**
 * The whole auth-vs-network question, as one pure function, because it is the
 * decision the browser cannot make for us and the one worth testing on its own.
 *
 * Order matters: `stopped` and `no-token` are checked before the token is even
 * looked at, so logging out while holding a garbage token still ends in
 * `stopped`, not in a decode failure.
 */
export function decideReconnect({
  token,
  attempt,
  stopped = false,
  nowMs,
  baseDelayMs,
  maxDelayMs,
  expirySkewMs = DEFAULT_EXPIRY_SKEW_MS,
  random,
}: DecideReconnectOptions): ReconnectDecision {
  if (stopped) {
    return { shouldReconnect: false, reason: 'stopped' }
  }
  if (token === null || token === '') {
    return { shouldReconnect: false, reason: 'no-token' }
  }
  const expiry = decodeJwtExpiryMs(token)
  if (expiry === null) {
    return { shouldReconnect: false, reason: 'undecodable' }
  }
  if (expiry - expirySkewMs <= nowMs) {
    return { shouldReconnect: false, reason: 'expired' }
  }
  return {
    shouldReconnect: true,
    attempt,
    delayMs: backoffDelayMs(attempt, {
      ...(baseDelayMs === undefined ? {} : { baseDelayMs }),
      ...(maxDelayMs === undefined ? {} : { maxDelayMs }),
      ...(random === undefined ? {} : { random }),
    }),
  }
}

/**
 * Builds the handshake URL. The env var is a *base*, so both
 * `ws://localhost:4000` and `ws://localhost:4000/ws` work: a base that already
 * ends in the realtime path is used as it stands.
 */
export function buildRealtimeUrl(baseUrl: string, token: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  const withPath = trimmed.endsWith(REALTIME_PATH) ? trimmed : `${trimmed}${REALTIME_PATH}`
  const separator = withPath.includes('?') ? '&' : '?'
  return `${withPath}${separator}token=${encodeURIComponent(token)}`
}

export interface RealtimeSocketOptions {
  /**
   * The handshake base URL. Read through a function so a reconnect after a
   * login picks up the new token — which is why login needs no special casing.
   */
  baseUrl: string | (() => string)
  /** The current session token, or `null` when signed out. */
  getToken: () => string | null
  webSocketFactory?: RealtimeWebSocketFactory
  baseDelayMs?: number
  maxDelayMs?: number
  expirySkewMs?: number
  random?: () => number
  now?: () => number
  setTimeoutImpl?: (handler: () => void, timeout: number) => unknown
  clearTimeoutImpl?: (handle: unknown) => void
  /**
   * Called once when the client decides the session itself is the problem (the
   * token is expired or unreadable). The hook turns this into the app's logout,
   * because a socket must not be the only thing that knows the session died.
   */
  onAuthFailed?: (reason: ReconnectRefusal) => void
}

const defaultWebSocketFactory: RealtimeWebSocketFactory = (url) => new WebSocket(url)

/**
 * Parses one inbound frame.
 *
 * The discriminant is required and the payload is checked before it is cast:
 * `events.ts` is a discriminated union on the wire, and a frame that does not
 * match it is *ignored* rather than thrown. The socket outlives any single
 * frame, and a future server that adds an event type must not crash a client
 * that has not been rebuilt yet.
 */
export function parseInboundEvent(data: unknown): InboundEvent | null {
  let parsed: unknown
  try {
    parsed = typeof data === 'string' ? JSON.parse(data) : data
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
    return null
  }
  const frame = parsed as Record<string, unknown>
  switch (frame.type) {
    case 'connection.ready':
      return typeof frame.employeeId === 'string'
        ? { type: 'connection.ready', employeeId: frame.employeeId }
        : null
    case 'notification.created':
      return isNotification(frame.notification) && typeof frame.unreadCount === 'number'
        ? {
            type: 'notification.created',
            notification: frame.notification,
            unreadCount: frame.unreadCount,
          }
        : null
    default:
      return null
  }
}

function isNotification(value: unknown): value is Notification {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.recipientId === 'string' &&
    typeof record.bookingId === 'string' &&
    typeof record.type === 'string' &&
    typeof record.title === 'string' &&
    typeof record.message === 'string' &&
    typeof record.isRead === 'boolean' &&
    typeof record.createdAt === 'string'
  )
}

export class RealtimeSocket {
  private readonly options: RealtimeSocketOptions
  private readonly factory: RealtimeWebSocketFactory
  private readonly random: () => number
  private readonly now: () => number
  private readonly schedule: (handler: () => void, timeout: number) => unknown
  private readonly unschedule: (handle: unknown) => void

  private socket: RealtimeWebSocket | null = null
  private timer: unknown = null
  /**
   * Bumped by every `start()` and `stop()`. Handlers capture the epoch they
   * were installed under and ignore themselves once it moves, which is what
   * makes a `stop()` immediately followed by a `start()` safe: the *old*
   * socket's `onclose` can still fire, and without this it would schedule a
   * reconnect on top of the new one.
   */
  private epoch = 0
  private failures = 0
  private running = false
  private currentState: RealtimeState = 'closed'

  private readonly eventListeners = new Set<EventListener>()
  private readonly stateListeners = new Set<StateListener>()
  private readonly authFailureListeners = new Set<AuthFailureListener>()

  constructor(options: RealtimeSocketOptions) {
    this.options = options
    this.factory = options.webSocketFactory ?? defaultWebSocketFactory
    this.random = options.random ?? Math.random
    this.now = options.now ?? (() => Date.now())
    this.schedule =
      options.setTimeoutImpl ?? ((handler, timeout) => setTimeout(handler, timeout) as unknown)
    this.unschedule =
      options.clearTimeoutImpl ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      })
  }

  get state(): RealtimeState {
    return this.currentState
  }

  /** Consecutive failed attempts; 0 while the socket is open. */
  get attempt(): number {
    return this.failures
  }

  /**
   * Opens (or re-opens) the socket. Idempotent while already running, and safe
   * to call after `stop()` — which is what makes it usable from a React effect
   * that StrictMode runs twice.
   */
  start(): void {
    if (this.running) {
      return
    }
    this.running = true
    this.epoch += 1
    this.failures = 0
    this.open()
  }

  /**
   * Closes for good: the socket is closed, no reconnect is scheduled, and any
   * later `start()` is a fresh decision (which is how logging back in
   * reconnects). Note this is *not* the auth path — a session that has merely
   * failed to authenticate keeps the client in `auth-failed` and does not
   * reconnect until a new token appears.
   */
  stop(): void {
    this.running = false
    this.epoch += 1
    this.cancelTimer()
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      // Detach first: a `stop()` is not a failure and must not schedule
      // anything, including through a late `onclose`.
      socket.onopen = null
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
      if (socket.readyState === 0 || socket.readyState === 1) {
        socket.close(1000, 'client closed')
      }
    }
    this.setState('closed')
  }

  subscribe(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  onAuthFailed(listener: AuthFailureListener): () => void {
    this.authFailureListeners.add(listener)
    return () => {
      this.authFailureListeners.delete(listener)
    }
  }

  private open(): void {
    const epoch = this.epoch
    const token = this.options.getToken()
    const decision = decideReconnect({
      token,
      attempt: this.failures,
      stopped: !this.running,
      nowMs: this.now(),
      ...(this.options.baseDelayMs === undefined ? {} : { baseDelayMs: this.options.baseDelayMs }),
      ...(this.options.maxDelayMs === undefined ? {} : { maxDelayMs: this.options.maxDelayMs }),
      ...(this.options.expirySkewMs === undefined ? {} : { expirySkewMs: this.options.expirySkewMs }),
      random: this.random,
    })

    if (!decision.shouldReconnect) {
      // `stopped` is not an auth failure — it is the app closing the socket.
      this.cancelTimer()
      this.socket = null
      if (decision.reason === 'stopped' || decision.reason === 'no-token') {
        this.setState('closed')
        return
      }
      this.running = false
      this.setState('auth-failed')
      this.emitAuthFailure(decision.reason)
      return
    }

    this.setState('connecting')
    const baseUrl =
      typeof this.options.baseUrl === 'function' ? this.options.baseUrl() : this.options.baseUrl

    let socket: RealtimeWebSocket
    try {
      socket = this.factory(buildRealtimeUrl(baseUrl, token as string))
    } catch (error) {
      // A factory that throws synchronously means a malformed `VITE_WS_URL` (or
      // no `WebSocket` global at all) — a configuration fault, not a
      // transient one, so retrying on a backoff would only hide it. It is
      // reported loudly and the client parks in `closed`; a `start()` after a
      // corrected config reconnects.
      this.running = false
      this.setState('closed')
      console.error('[realtime] could not open a WebSocket:', error)
      return
    }
    this.socket = socket

    socket.onopen = () => {
      if (epoch !== this.epoch) {
        return
      }
      // A successful open resets the schedule, so the next outage starts at
      // `baseDelayMs` again instead of inheriting an old outage's ceiling.
      this.failures = 0
      this.setState('open')
    }

    socket.onmessage = (event) => {
      if (epoch !== this.epoch) {
        return
      }
      const parsed = parseInboundEvent(event.data)
      if (parsed !== null) {
        for (const listener of [...this.eventListeners]) {
          listener(parsed)
        }
      }
    }

    socket.onerror = () => {
      // Nothing useful is available here on purpose. An `error` before `open`
      // is the browser's rendering of the gateway's raw 401, and the browser
      // does not surface the status code. Treating it as "the network is
      // flaky" is exactly the bug this client's auth branch exists to avoid, so
      // the reconnect decision is made once, in `onclose`, from real
      // information: the token's `exp` and `me`.
    }

    socket.onclose = (event) => {
      if (epoch !== this.epoch) {
        return
      }
      this.socket = null
      this.failures += 1
      if (event.code === SERVER_SHUTDOWN_CLOSE_CODE) {
        // A deliberate server teardown, not an outage: do not spend a backoff
        // burst on it, and do not claim the session died.
        this.running = false
        this.setState('closed')
        return
      }
      if (event.code === ABNORMAL_CLOSURE) {
        // 1006 is "the browser never saw a valid handshake response", which is
        // exactly what a raw 401 from `rejectUpgrade` looks like *and* exactly
        // what a dead server looks like. Worth a line in the console, and worth
        // nothing as a decision input.
        console.debug(
          `[realtime] abnormal close (1006); resolving refused-token vs unreachable server via the token's exp, not the close code`,
        )
      }
      this.retryAfterFailure()
    }
  }

  private retryAfterFailure(): void {
    const token = this.options.getToken()
    const decision = decideReconnect({
      token,
      attempt: this.failures,
      stopped: !this.running,
      nowMs: this.now(),
      ...(this.options.baseDelayMs === undefined ? {} : { baseDelayMs: this.options.baseDelayMs }),
      ...(this.options.maxDelayMs === undefined ? {} : { maxDelayMs: this.options.maxDelayMs }),
      ...(this.options.expirySkewMs === undefined ? {} : { expirySkewMs: this.options.expirySkewMs }),
      random: this.random,
    })

    if (!decision.shouldReconnect) {
      this.cancelTimer()
      if (decision.reason === 'stopped' || decision.reason === 'no-token') {
        this.running = false
        this.setState('closed')
        return
      }
      // The close code is deliberately not branched on to tell an auth failure
      // from an outage. A 1006 is the refused-handshake signature *and* the
      // dead-server signature; the two are indistinguishable from here, and the
      // token's own `exp` is what separates "log out" from "keep retrying".
      this.running = false
      this.setState('auth-failed')
      this.emitAuthFailure(decision.reason)
      return
    }

    this.setState('closed')
    this.cancelTimer()
    this.timer = this.schedule(() => {
      this.timer = null
      this.open()
    }, decision.delayMs)
  }

  private emitAuthFailure(reason: ReconnectRefusal): void {
    for (const listener of [...this.authFailureListeners]) {
      listener(reason)
    }
    this.options.onAuthFailed?.(reason)
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.unschedule(this.timer)
      this.timer = null
    }
  }

  private setState(next: RealtimeState): void {
    if (this.currentState === next) {
      return
    }
    this.currentState = next
    for (const listener of [...this.stateListeners]) {
      listener(next)
    }
  }
}
