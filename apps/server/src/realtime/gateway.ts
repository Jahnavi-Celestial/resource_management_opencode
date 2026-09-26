import type { IncomingMessage, Server } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import type { DataSource } from 'typeorm'
// FR-90: the realtime handshake authenticates through the same resolver the
// GraphQL context uses, so token verification is never reimplemented here.
import { resolveAuthContext } from '../auth/resolve-auth-context'
import { ConnectionRegistry } from './connection-registry'
import type { RealtimeEmitter, RealtimeEvent } from './events'

export const REALTIME_PATH = '/ws'

/** Application close code sent when a live connection is torn down by the server. */
export const SERVER_SHUTDOWN_CLOSE_CODE = 4401

type AuthContext = NonNullable<Awaited<ReturnType<typeof resolveAuthContext>>>

export interface RealtimeGateway {
  readonly registry: ConnectionRegistry
  readonly path: string
  /** Writes one event to every live socket of `employeeId`; 0 when offline. */
  broadcast(employeeId: string, event: RealtimeEvent): number
  close(code?: number, reason?: string): Promise<void>
}

export interface RealtimeGatewayOptions {
  path?: string
}

const BEARER_PREFIX = /^Bearer\s+/i

/**
 * Reads the JWT from the handshake. Node clients can send an Authorization
 * header; browsers cannot set headers on a WebSocket, so `?token=` is also
 * accepted. Header wins when both are present.
 */
export function extractHandshakeToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization
  if (typeof authorization === 'string') {
    const match = BEARER_PREFIX.exec(authorization.trim())
    if (match !== null) {
      const token = authorization.trim().slice(match[0].length).trim()
      if (token.length > 0) {
        return token
      }
    }
  }
  let queryToken: string | null = null
  try {
    queryToken = new URL(request.url ?? '/', 'http://localhost').searchParams.get('token')
  } catch {
    queryToken = null
  }
  return queryToken !== null && queryToken.length > 0 ? queryToken : null
}

/** Refuses the upgrade before the WebSocket is established, so the client never opens. */
function rejectUpgrade(socket: Socket, status: 400 | 401 | 404, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

export function createRealtimeGateway(
  server: Server,
  dataSource: DataSource,
  options: RealtimeGatewayOptions = {},
): RealtimeGateway {
  const path = options.path ?? REALTIME_PATH
  const registry = new ConnectionRegistry()
  const wss = new WebSocketServer({ noServer: true, clientTracking: false })

  const broadcast: RealtimeEmitter = (employeeId, event) => {
    const sockets = registry.get(employeeId)
    if (sockets.length === 0) {
      return 0
    }
    const payload = JSON.stringify(event)
    let delivered = 0
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue
      }
      socket.send(payload)
      delivered += 1
    }
    return delivered
  }

  const onConnection = (socket: WebSocket, auth: AuthContext): void => {
    const employeeId = auth.employee.id
    registry.add(employeeId, socket)
    socket.send(JSON.stringify({ type: 'connection.ready', employeeId }))
    socket.on('close', () => {
      registry.remove(employeeId, socket)
    })
    // A broken pipe must not take the process down.
    socket.on('error', (error: Error) => {
      console.error(`[realtime] socket error for employee ${employeeId}: ${error.message}`)
      registry.remove(employeeId, socket)
    })
  }

  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    void (async () => {
      let pathname: string
      try {
        pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      } catch {
        rejectUpgrade(socket, 400, 'Bad Request')
        return
      }
      if (pathname !== path) {
        rejectUpgrade(socket, 404, 'Not Found')
        return
      }
      const token = extractHandshakeToken(request)
      const auth = token === null ? null : await resolveAuthContext(dataSource, token)
      if (auth === null) {
        rejectUpgrade(socket, 401, 'Unauthorized')
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        onConnection(ws, auth)
      })
    })()
  }

  server.on('upgrade', onUpgrade)

  /**
   * Tears the gateway down. Socket close frames go out synchronously, but the
   * `ws` close callback is deliberately not awaited: a client that never
   * finishes the closing handshake would otherwise hang shutdown, and a hung
   * shutdown means the HTTP port is never released.
   */
  const close = async (code = SERVER_SHUTDOWN_CLOSE_CODE, reason = 'Server shutting down'): Promise<void> => {
    server.off('upgrade', onUpgrade)
    registry.closeAll(code, reason)
    wss.close(() => undefined)
  }

  return { registry, path, broadcast, close }
}

let activeGateway: RealtimeGateway | null = null

/**
 * Publishes the process-wide gateway. main.ts attaches the real one on boot;
 * tests attach a throwaway one. Passing null detaches, after which emits are
 * no-ops — a notification created with nobody connected is still written to
 * the database, it is simply not pushed anywhere.
 */
export function attachRealtimeGateway(gateway: RealtimeGateway | null): void {
  activeGateway = gateway
}

export const emitRealtimeEvent: RealtimeEmitter = (employeeId, event) =>
  activeGateway === null ? 0 : activeGateway.broadcast(employeeId, event)
