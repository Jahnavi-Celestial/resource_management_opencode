import type { WebSocket } from 'ws'

/**
 * employeeId -> the set of sockets currently held open by that employee.
 *
 * A user may have several live connections at once (multiple tabs, phone and
 * desktop), so every event is fanned out to the whole set rather than to a
 * single "current" socket. Sockets are removed on close, which makes the
 * registry self-healing: a client that disappears without a close frame is
 * dropped when the connection emits 'close'.
 */
export class ConnectionRegistry {
  private readonly byEmployee = new Map<string, Set<WebSocket>>()

  add(employeeId: string, socket: WebSocket): void {
    let sockets = this.byEmployee.get(employeeId)
    if (sockets === undefined) {
      sockets = new Set<WebSocket>()
      this.byEmployee.set(employeeId, sockets)
    }
    sockets.add(socket)
  }

  remove(employeeId: string, socket: WebSocket): void {
    const sockets = this.byEmployee.get(employeeId)
    if (sockets === undefined) {
      return
    }
    sockets.delete(socket)
    if (sockets.size === 0) {
      this.byEmployee.delete(employeeId)
    }
  }

  /** Live sockets for one employee. Returns an empty array, never throws. */
  get(employeeId: string): WebSocket[] {
    const sockets = this.byEmployee.get(employeeId)
    return sockets === undefined ? [] : [...sockets]
  }

  count(employeeId: string): number {
    return this.byEmployee.get(employeeId)?.size ?? 0
  }

  /** Total live sockets across all employees. */
  get size(): number {
    let total = 0
    for (const sockets of this.byEmployee.values()) {
      total += sockets.size
    }
    return total
  }

  /** Closes every socket with an application close code and empties the map. */
  closeAll(code: number, reason: string): void {
    for (const sockets of this.byEmployee.values()) {
      for (const socket of sockets) {
        socket.close(code, reason)
      }
    }
    this.byEmployee.clear()
  }
}
