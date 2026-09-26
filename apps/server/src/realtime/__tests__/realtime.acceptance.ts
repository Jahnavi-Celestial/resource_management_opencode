import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import * as jwt from 'jsonwebtoken'
import { In } from 'typeorm'
import { WebSocket, type ClientOptions } from 'ws'
import { createApp } from '../../app'
import { createDataSource } from '../../config/data-source'
import { signEmployeeToken } from '../../auth/jwt'
import { SYSTEM_EMPLOYEE_EMAIL } from '../../modules/employee/system-account'
import { Booking } from '../../modules/booking/booking.entity'
import { BookingEquipment } from '../../modules/booking/booking-equipment.entity'
import { BookingService } from '../../modules/booking/booking.service'
import { AuditLog } from '../../modules/audit/audit-log.entity'
import { Employee } from '../../modules/employee/employee.entity'
import { MeetingRoom } from '../../modules/room/room.entity'
import { Role } from '../../modules/rbac/role.entity'
import { UserRole } from '../../modules/rbac/user-role.entity'
import { Notification } from '../../modules/notification/notification.entity'
import { EmailOutbox } from '../../email/email-outbox.entity'
import { attachRealtimeGateway, createRealtimeGateway } from '../gateway'
import { ConnectionRegistry } from '../connection-registry'
import type { NotificationCreatedEvent } from '../events'

type Frame = { type: string } & Record<string, unknown>

type Attempt = { opened: boolean; status: number | null; error: string | null }

type Waiter = {
  type: string
  resolve: (frame: Frame) => void
  timer: ReturnType<typeof setTimeout>
}

const EVENT_TIMEOUT_MS = 5000
const PASSWORD_HASH = '$2b$12$realtime.acceptance.password.hash.0000000000000000000000'

/**
 * A real WebSocket client: opens a genuine connection to the running server and
 * buffers every frame it receives, so a test can await a specific event type
 * instead of polling a query.
 */
class RealtimeTestClient {
  private readonly frames: Frame[] = []
  private readonly waiters: Waiter[] = []
  private readonly socket: WebSocket

  private constructor(url: string, options: ClientOptions | undefined) {
    this.socket = new WebSocket(url, options)
    // Keep a permanent listener so a late socket error can never become an
    // unhandled 'error' event and take the test process down.
    this.socket.on('error', () => undefined)
    this.socket.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as Frame
      this.frames.push(frame)
      for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.waiters[index]
        if (waiter !== undefined && waiter.type === frame.type) {
          clearTimeout(waiter.timer)
          this.waiters.splice(index, 1)
          waiter.resolve(frame)
        }
      }
    })
  }

  static open(url: string, options?: ClientOptions): Promise<RealtimeTestClient> {
    return new Promise((resolve, reject) => {
      const client = new RealtimeTestClient(url, options)
      const timer = setTimeout(() => reject(new Error('timed out opening')), EVENT_TIMEOUT_MS)
      client.socket.once('open', () => {
        clearTimeout(timer)
        resolve(client)
      })
      client.socket.once('error', (error: Error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  /** Index of the next frame, for use as the `since` cursor of `next`. */
  mark(): number {
    return this.frames.length
  }

  /**
   * Resolves with the next frame of `type` at or after the `since` cursor,
   * including one that already arrived. Frames buffered before the mark are
   * ignored, so a repeated event type is never mistaken for the fresh one.
   */
  next(type: string, since = 0, timeoutMs: number = EVENT_TIMEOUT_MS): Promise<Frame> {
    const buffered = this.frames.findIndex((frame, index) => index >= since && frame.type === type)
    if (buffered >= 0) {
      return Promise.resolve(this.frames[buffered] as Frame)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out after ${timeoutMs}ms waiting for "${type}"`))
      }, timeoutMs)
      this.waiters.push({ type, resolve, timer })
    })
  }

  countOf(type: string): number {
    return this.frames.filter((frame) => frame.type === type).length
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve()
        return
      }
      this.socket.once('close', () => {
        resolve()
      })
      this.socket.close()
    })
  }
}

/** Resolves with how the handshake ended, whether accepted or refused. */
function attemptConnection(url: string, options?: ClientOptions): Promise<Attempt> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, options)
    let settled = false
    const finish = (attempt: Attempt): void => {
      if (settled) return
      settled = true
      resolve(attempt)
    }
    const timer = setTimeout(() => {
      socket.terminate()
      finish({ opened: false, status: null, error: 'timed out' })
    }, EVENT_TIMEOUT_MS)
    socket.on('open', () => {
      clearTimeout(timer)
      finish({ opened: true, status: 101, error: null })
    })
    socket.on('unexpected-response', (request, response) => {
      clearTimeout(timer)
      const status = response.statusCode ?? null
      response.destroy()
      request.destroy()
      finish({ opened: false, status, error: null })
    })
    socket.on('error', (error: Error) => {
      clearTimeout(timer)
      finish({ opened: false, status: null, error: error.message })
    })
  })
}

function notificationEvent(frame: Frame): NotificationCreatedEvent {
  assert.equal(frame.type, 'notification.created')
  const notification = frame.notification as NotificationCreatedEvent['notification']
  const unreadCount = frame.unreadCount
  assert.equal(typeof notification.id, 'string')
  if (typeof unreadCount !== 'number') {
    throw new Error('notification.created frame carried no numeric unreadCount')
  }
  return { type: 'notification.created', notification, unreadCount }
}

async function main(): Promise<void> {
  const dataSource = createDataSource()
  dataSource.setOptions({ logging: ['error'] })
  await dataSource.initialize()

  const app = await createApp(dataSource)
  const server = app.listen(0)
  await new Promise<void>((resolve) => {
    if (server.listening) {
      resolve()
      return
    }
    server.once('listening', () => {
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const base = `ws://127.0.0.1:${address.port}`
  const gateway = createRealtimeGateway(server, dataSource)
  attachRealtimeGateway(gateway)
  const registry: ConnectionRegistry = gateway.registry

  const runId = randomUUID().slice(0, 8)
  const employeeRepository = dataSource.getRepository(Employee)
  const roomRepository = dataSource.getRepository(MeetingRoom)
  const bookingRepository = dataSource.getRepository(Booking)
  const notificationRepository = dataSource.getRepository(Notification)
  const bookingIds: string[] = []
  const employeeIds: string[] = []
  let roomId: string | null = null
  const openClients: RealtimeTestClient[] = []

  const client = async (employeeId: string, viaHeader = false): Promise<RealtimeTestClient> => {
    const token = signEmployeeToken(employeeId)
    const opened = viaHeader
      ? await RealtimeTestClient.open(`${base}/ws`, { headers: { authorization: `Bearer ${token}` } })
      : await RealtimeTestClient.open(`${base}/ws?token=${token}`)
    openClients.push(opened)
    return opened
  }

  try {
    const [requester, manager, offline] = await employeeRepository.save([
      employeeRepository.create({
        firstName: `Wren${runId}`,
        lastName: 'Requester',
        email: `wren-${runId}@example.test`,
        password: PASSWORD_HASH,
      }),
      employeeRepository.create({
        firstName: `Kai${runId}`,
        lastName: 'Manager',
        email: `kai-${runId}@example.test`,
        password: PASSWORD_HASH,
      }),
      employeeRepository.create({
        firstName: `Ola${runId}`,
        lastName: 'Offline',
        email: `ola-${runId}@example.test`,
        password: PASSWORD_HASH,
      }),
    ])
    if (requester === undefined || manager === undefined || offline === undefined) {
      throw new Error('Realtime employee fixture creation returned too few rows')
    }
    employeeIds.push(requester.id, manager.id, offline.id)

    const managerRole = await dataSource.getRepository(Role).findOneByOrFail({ roleName: 'Manager' })
    await dataSource
      .getRepository(UserRole)
      .save(dataSource.getRepository(UserRole).create({ employeeId: manager.id, roleId: managerRole.id }))

    const room = await roomRepository.save(
      roomRepository.create({
        name: `Realtime room ${runId}`,
        location: `Lab ${runId}`,
        capacity: 20,
        isActive: true,
      }),
    )
    roomId = room.id

    const bookingService = new BookingService(dataSource)
    let slot = 0
    const submit = async (employeeId: string, purpose: string) => {
      slot += 1
      const startTime = new Date(Date.now() + (30 + slot) * 86400000)
      const booking = await bookingService.createBooking(employeeId, {
        roomId: room.id,
        startTime,
        endTime: new Date(startTime.getTime() + 3600000),
        purpose,
        numberOfAttendees: 2,
      })
      bookingIds.push(booking.id)
      return booking
    }
    const unreadInDb = async (employeeId: string): Promise<number> =>
      notificationRepository.count({ where: { recipientId: employeeId, isRead: false } })

    // --- 1. a valid JWT on the handshake is accepted -------------------------
    const requesterClient = await client(requester.id, true)
    const ready = await requesterClient.next('connection.ready')
    assert.equal(ready.employeeId, requester.id)
    assert.equal(registry.count(requester.id), 1)
    assert.equal(registry.size, 1)
    console.log(
      `1. valid JWT: opened=true ready.employeeId=${String(ready.employeeId)} registry[${requester.id}]=${registry.count(requester.id)} via=Authorization header`,
    )

    // --- 2. missing / invalid / forged / system-account tokens are refused ---
    const systemEmployee = await employeeRepository.findOneBy({ email: SYSTEM_EMPLOYEE_EMAIL })
    assert.notEqual(systemEmployee, null, 'system account must be seeded for this check')
    const forged = jwt.sign({ sub: requester.id }, 'not-the-server-secret', {
      algorithm: 'HS256',
      expiresIn: '1h',
    })
    const refusals: Array<{ label: string; attempt: Attempt; expectedStatus: number }> = [
      { label: 'no token', attempt: await attemptConnection(`${base}/ws`), expectedStatus: 401 },
      { label: 'garbage token', attempt: await attemptConnection(`${base}/ws?token=not-a-jwt`), expectedStatus: 401 },
      {
        label: 'wrong signature',
        attempt: await attemptConnection(`${base}/ws?token=${forged}`),
        expectedStatus: 401,
      },
      {
        label: 'system account',
        attempt: await attemptConnection(`${base}/ws?token=${signEmployeeToken((systemEmployee as Employee).id)}`),
        expectedStatus: 401,
      },
      { label: 'wrong path', attempt: await attemptConnection(`${base}/nope?token=${signEmployeeToken(requester.id)}`), expectedStatus: 404 },
    ]
    for (const refusal of refusals) {
      assert.equal(refusal.attempt.opened, false, `${refusal.label} must not open`)
      assert.equal(
        refusal.attempt.status,
        refusal.expectedStatus,
        `${refusal.label}: expected HTTP ${refusal.expectedStatus}, got ${String(refusal.attempt.status)}`,
      )
    }
    assert.equal(registry.size, 1, 'refused handshakes must not register a socket')
    console.log(
      `2. refusals: ${refusals
        .map((refusal) => `${refusal.label}=HTTP ${String(refusal.attempt.status)}`)
        .join(', ')} registryStillSize=${registry.size}`,
    )

    // --- 3. an approval reaches the requester's socket, with unread count ----
    const beforeRequester = await unreadInDb(requester.id)
    const pending = await submit(requester.id, `Realtime approval ${runId}`)
    assert.equal(
      await unreadInDb(requester.id),
      beforeRequester,
      'the requester gets no pending notice about their own request',
    )
    assert.equal(
      requesterClient.countOf('notification.created'),
      0,
      'the requester must not be pushed their own pending notice',
    )
    const startedAt = Date.now()
    const approvalMark = requesterClient.mark()
    await bookingService.approveBooking(manager.id, pending.id)
    const approvalFrame = notificationEvent(await requesterClient.next('notification.created', approvalMark))
    const elapsed = Date.now() - startedAt
    assert.equal(approvalFrame.notification.type, 'BOOKING_APPROVED')
    assert.equal(approvalFrame.notification.recipientId, requester.id)
    assert.equal(approvalFrame.notification.bookingId, pending.id)
    assert.equal(approvalFrame.notification.isRead, false)
    assert.equal(approvalFrame.unreadCount, (await unreadInDb(requester.id)))
    assert.equal(approvalFrame.unreadCount, beforeRequester + 1)
    const persisted = await notificationRepository.findOneByOrFail({
      bookingId: pending.id,
      recipientId: requester.id,
      type: 'BOOKING_APPROVED',
    })
    assert.equal(persisted.id, approvalFrame.notification.id, 'pushed id must match the stored row')
    console.log(
      `3. live approval: type=${approvalFrame.notification.type} pushedId=${persisted.id} unreadCount=${approvalFrame.unreadCount} (db=${approvalFrame.unreadCount}) pushedIn=${elapsed}ms polls=0`,
    )

    // --- 4. two tabs for one employee both receive the same event ------------
    const secondTab = await client(requester.id)
    await secondTab.next('connection.ready')
    assert.equal(registry.count(requester.id), 2)
    const rejected = await submit(requester.id, `Realtime reject ${runId}`)
    const tabOneMark = requesterClient.mark()
    const tabTwoMark = secondTab.mark()
    await bookingService.rejectBooking(manager.id, rejected.id, 'room was double-booked')
    const [tabOneFrame, tabTwoFrame] = await Promise.all([
      requesterClient.next('notification.created', tabOneMark),
      secondTab.next('notification.created', tabTwoMark),
    ])
    const tabOneEvent = notificationEvent(tabOneFrame)
    const tabTwoEvent = notificationEvent(tabTwoFrame)
    assert.equal(tabOneEvent.notification.id, tabTwoEvent.notification.id)
    assert.equal(tabOneEvent.unreadCount, tabTwoEvent.unreadCount)
    assert.equal(tabOneEvent.notification.bookingId, rejected.id)
    assert.equal(tabOneEvent.notification.type, 'BOOKING_REJECTED')
    assert.ok(
      tabOneEvent.notification.message.includes('room was double-booked'),
      'rejection reason must reach the client',
    )
    console.log(
      `4. two tabs: registry[${requester.id}]=${registry.count(requester.id)} sameEventId=${tabOneEvent.notification.id} bothGotType=${tabTwoEvent.notification.type} unreadCount=${tabOneEvent.unreadCount}`,
    )

    // --- 5. a recipient with no socket: the row is still written, no crash ---
    const offlineBooking = await submit(offline.id, `Realtime offline ${runId}`)
    const beforeOffline = await unreadInDb(offline.id)
    assert.equal(registry.count(offline.id), 0, 'offline user must have no socket')
    assert.equal(gateway.broadcast(offline.id, approvalFrame), 0, 'broadcast to nobody returns 0')
    await bookingService.approveBooking(manager.id, offlineBooking.id)
    const offlineRows = await notificationRepository.find({
      where: { bookingId: offlineBooking.id, recipientId: offline.id, type: 'BOOKING_APPROVED' },
    })
    assert.equal(offlineRows.length, 1, 'the notification must still exist in the database')
    assert.equal(offlineRows[0]?.isRead, false)
    assert.equal(await unreadInDb(offline.id), beforeOffline + 1)
    assert.equal(registry.size, 2, 'an offline delivery must not register or drop sockets')
    console.log(
      `5. no socket: rowsInDb=${offlineRows.length} unreadCount=${beforeOffline + 1} broadcastToOffline=0 registryStillSize=${registry.size} noError=true`,
    )

    // --- 6. the approver fan-out reaches every approver socket --------------
    const managerClient = await client(manager.id)
    await managerClient.next('connection.ready')
    const managerUnreadBefore = await unreadInDb(manager.id)
    const managerMark = managerClient.mark()
    const fanout = await submit(requester.id, `Realtime fanout ${runId}`)
    const pendingForManager = notificationEvent(
      await managerClient.next('notification.created', managerMark),
    )
    assert.equal(pendingForManager.notification.type, 'BOOKING_PENDING')
    assert.equal(pendingForManager.notification.recipientId, manager.id)
    assert.equal(pendingForManager.notification.bookingId, fanout.id)
    assert.equal(pendingForManager.unreadCount, managerUnreadBefore + 1)
    const requesterStillQuiet = requesterClient.countOf('notification.created')
    assert.equal(requesterStillQuiet, 2, 'requester must not be told about their own pending booking')
    console.log(
      `6. fan-out to approver: type=${pendingForManager.notification.type} recipientIsManager=true unreadCount=${pendingForManager.unreadCount} requesterEventsUnchanged=${requesterStillQuiet}`,
    )

    // --- 7. closing a socket unregisters it --------------------------------
    await secondTab.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(registry.count(requester.id), 1)
    assert.equal(registry.size, 2)
    console.log(`7. disconnect: registry[${requester.id}]=${registry.count(requester.id)} totalSockets=${registry.size}`)

    // --- 8. with no gateway attached the emit is a silent no-op -------------
    attachRealtimeGateway(null)
    const detachedBooking = await submit(requester.id, `Realtime detached ${runId}`)
    await bookingService.approveBooking(manager.id, detachedBooking.id)
    const detachedRows = await notificationRepository.count({
      where: { bookingId: detachedBooking.id, recipientId: requester.id, type: 'BOOKING_APPROVED' },
    })
    assert.equal(detachedRows, 1, 'writes must not depend on a live gateway')
    assert.equal(
      requesterClient.countOf('notification.created'),
      2,
      'no gateway attached means nothing is pushed',
    )
    attachRealtimeGateway(gateway)
    console.log(
      `8. gateway detached: rowsInDb=${detachedRows} pushedFrames=${requesterClient.countOf('notification.created')} noError=true`,
    )

    console.log('PASS realtime acceptance')
  } finally {
    attachRealtimeGateway(null)
    for (const opened of openClients) {
      await opened.close()
    }
    await gateway.close()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
    if (bookingIds.length > 0) {
      await dataSource.getRepository(BookingEquipment).delete({ bookingId: In(bookingIds) })
      await dataSource.getRepository(AuditLog).delete({ bookingId: In(bookingIds) })
      await notificationRepository.delete({ bookingId: In(bookingIds) })
      await bookingRepository.delete({ id: In(bookingIds) })
    }
    if (employeeIds.length > 0) {
      await dataSource.getRepository(UserRole).delete({ employeeId: In(employeeIds) })
      await dataSource.getRepository(Notification).delete({ recipientId: In(employeeIds) })
      // The outbox is addressed, not linked: scope it by the fixture employees'
      // own addresses, before those rows disappear.
      const fixtureEmails = (
        await employeeRepository
          .createQueryBuilder('employee')
          .select('employee.email', 'email')
          .where('employee.id IN (:...ids)', { ids: employeeIds })
          .getRawMany<{ email: string }>()
      ).map((row) => row.email)
      if (fixtureEmails.length > 0) {
        await dataSource.getRepository(EmailOutbox).delete({ toEmail: In(fixtureEmails) })
      }
      await employeeRepository.delete({ id: In(employeeIds) })
    }
    if (roomId !== null) {
      await roomRepository.delete({ id: roomId })
    }
    await dataSource.destroy()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(`FAIL realtime acceptance\n${message}`)
  process.exit(1)
})
