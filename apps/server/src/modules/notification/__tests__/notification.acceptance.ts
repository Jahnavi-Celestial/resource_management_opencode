import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { graphql, type ExecutionResult } from 'graphql'
import { In, type EntityManager } from 'typeorm'
import { buildSchema } from 'type-graphql'
import { authChecker } from '../../../auth/auth-checker'
import { createDataSource } from '../../../config/data-source'
import type { GraphQLContext } from '../../../common/graphql/context'
import { runInTransaction } from '../../../common/db/transaction'
import { createLoaders } from '../../../loaders'
import { Booking } from '../../booking/booking.entity'
import { BookingService } from '../../booking/booking.service'
import { BookingEquipment } from '../../booking/booking-equipment.entity'
import { AuditLog } from '../../audit/audit-log.entity'
import { Employee } from '../../employee/employee.entity'
import { MeetingRoom } from '../../room/room.entity'
import { Role } from '../../rbac/role.entity'
import { UserRole } from '../../rbac/user-role.entity'
import { Notification } from '../notification.entity'
import { EmailOutbox } from '../../../email/email-outbox.entity'
import { NotificationRepository } from '../notification.repository'
import { NotificationResolver } from '../notification.resolver'
import { NotificationService, type BookingNotificationDetails } from '../notification.service'
import type { NotificationRecordType } from '../notification.types'
import type { NotificationType } from '@resource-booking/shared'

type NotificationItem = {
  id: string
  recipientId: string
  bookingId: string
  type: string
  title: string
  message: string
  isRead: boolean
}

type NotificationListData = {
  myNotifications: { totalCount: number; items: NotificationItem[] }
}

type SortArg = { field: string; direction: 'ASC' | 'DESC' } | null

const listQuery = `
  query MyNotifications($page: Int!, $pageSize: Int!, $sort: SortInput, $type: NotificationType, $unreadOnly: Boolean) {
    myNotifications(page: $page, pageSize: $pageSize, sort: $sort, type: $type, unreadOnly: $unreadOnly) {
      totalCount
      items { id recipientId bookingId type title message isRead }
    }
  }
`

const unreadQuery = `
  query UnreadCount {
    unreadCount
  }
`

const markReadMutation = `
  mutation MarkNotificationRead($id: String!) {
    markNotificationRead(id: $id) { id isRead }
  }
`

const markAllReadMutation = `
  mutation MarkAllNotificationsRead {
    markAllNotificationsRead
  }
`

function requireData<T>(result: ExecutionResult): T {
  assert.equal(result.errors, undefined, JSON.stringify(result.errors))
  assert.notEqual(result.data, null)
  return result.data as T
}

function firstError(result: ExecutionResult): { message: string; name: string } {
  const error = result.errors?.[0]
  assert.notEqual(error, undefined, `expected an error, got data ${JSON.stringify(result.data)}`)
  const original = error?.originalError
  return {
    message: error?.message ?? '',
    name: original instanceof Error ? original.name : 'GraphQLError',
  }
}

async function main(): Promise<void> {
  const dataSource = createDataSource()
  dataSource.setOptions({ logging: ['error'] })
  await dataSource.initialize()

  const runId = randomUUID().slice(0, 8)
  const service = new NotificationService()
  const employeeRepository = dataSource.getRepository(Employee)
  const roomRepository = dataSource.getRepository(MeetingRoom)
  const bookingRepository = dataSource.getRepository(Booking)
  const notificationRepository = dataSource.getRepository(Notification)
  let roomId: string | null = null
  let lifecycleRoomId: string | null = null
  const bookingIds: string[] = []
  const lifecycleBookingIds: string[] = []
  const employeeIds: string[] = []

  try {
    const savedEmployees = await employeeRepository.save([
      employeeRepository.create({
        firstName: `Alice${runId}`,
        lastName: 'Recipient',
        email: `alice-${runId}@example.test`,
        password: '$2b$12$notification.acceptance.password.hash.0000000000000000000000',
      }),
      employeeRepository.create({
        firstName: `Bob${runId}`,
        lastName: 'Recipient',
        email: `bob-${runId}@example.test`,
        password: '$2b$12$notification.acceptance.password.hash.0000000000000000000000',
      }),
    ])
    const alice = savedEmployees[0]
    const bob = savedEmployees[1]
    if (alice === undefined || bob === undefined) {
      throw new Error('Notification employee fixture creation returned too few rows')
    }
    employeeIds.push(alice.id, bob.id)

    const room = await roomRepository.save(
      roomRepository.create({
        name: `Notification room ${runId}`,
        location: `Lab ${runId}`,
        capacity: 20,
        isActive: true,
      }),
    )
    roomId = room.id

    const bookings = await bookingRepository.save(
      ['own', 'reminder', 'rollback'].map((suffix, index) =>
        bookingRepository.create({
          employeeId: alice.id,
          roomId: room.id,
          startTime: new Date(Date.UTC(2032, 2, 10 + index, 10)),
          endTime: new Date(Date.UTC(2032, 2, 10 + index, 11)),
          purpose: `Notification fixture ${suffix} ${runId}`,
          numberOfAttendees: 2,
          status: 'APPROVED' as const,
        }),
      ),
    )
    const [ownBooking, reminderBooking, rollbackBooking] = bookings
    if (ownBooking === undefined || reminderBooking === undefined || rollbackBooking === undefined) {
      throw new Error('Notification booking fixture creation returned too few rows')
    }
    bookingIds.push(...bookings.map((booking) => booking.id))

    const schema = await buildSchema({ resolvers: [NotificationResolver], authChecker })
    const contextFor = (employee: Employee | null): GraphQLContext =>
      ({
        dataSource,
        auth:
          employee === null
            ? null
            : { employee, roles: [], permissionKeys: new Set<string>() },
        loaders: createLoaders(dataSource),
      }) as unknown as GraphQLContext
    const aliceContext = contextFor(alice)
    const bobContext = contextFor(bob)
    const anonymousContext = contextFor(null)

    const createNotification = async (
      recipientId: string,
      bookingId: string,
      type: NotificationType,
      label: string = type,
    ): Promise<NotificationItem> =>
      service.create(dataSource.manager, {
        recipientId,
        bookingId,
        type,
        title: `${label} ${runId}`,
        message: `Notification fixture message for ${label}`,
      })

    const list = async (
      context: GraphQLContext,
      page = 1,
      pageSize = 20,
      sort: SortArg = { field: 'createdAt', direction: 'DESC' },
      type: string | null = null,
      unreadOnly: boolean | null = null,
    ): Promise<NotificationListData> =>
      requireData(
        await graphql({
          schema,
          source: listQuery,
          contextValue: context,
          variableValues: { page, pageSize, sort, type, unreadOnly },
        }),
      )

    // --- 1. create via the service, then list with pagination -----------------
    const aliceTypes: NotificationType[] = [
      'BOOKING_PENDING',
      'BOOKING_APPROVED',
      'BOOKING_REJECTED',
      'BOOKING_CANCELLED',
    ]
    const created: NotificationItem[] = []
    for (const type of aliceTypes) {
      created.push(await createNotification(alice.id, ownBooking.id, type))
    }
    const reminder = await createNotification(alice.id, reminderBooking.id, 'REMINDER')
    created.push(reminder)
    const bobs = await createNotification(bob.id, ownBooking.id, 'BOOKING_PENDING', 'Bob private')

    const allAlice = await list(aliceContext)
    assert.equal(allAlice.myNotifications.totalCount, 5)
    assert.equal(allAlice.myNotifications.items.length, 5)
    assert.deepEqual(
      new Set(allAlice.myNotifications.items.map((item) => item.recipientId)),
      new Set([alice.id]),
    )
    assert.ok(
      !allAlice.myNotifications.items.some((item) => item.id === bobs.id),
      "another user's notification leaked into myNotifications",
    )
    assert.deepEqual(
      new Set(allAlice.myNotifications.items.map((item) => item.type)),
      new Set([...aliceTypes, 'REMINDER']),
    )
    assert.ok(allAlice.myNotifications.items.every((item) => item.isRead === false))
    assert.ok(allAlice.myNotifications.items.every((item) => item.recipientId === alice.id))
    console.log(
      `1. create+list: totalCount=${allAlice.myNotifications.totalCount} items=${allAlice.myNotifications.items.length} types=${[...new Set(allAlice.myNotifications.items.map((item) => item.type))].sort().join(',')}`,
    )

    const pages = [1, 2, 3]
    const pagedIds: string[] = []
    for (const page of pages) {
      const result = await list(aliceContext, page, 2, { field: 'type', direction: 'ASC' })
      assert.equal(result.myNotifications.totalCount, 5)
      assert.equal(result.myNotifications.items.length, page === 3 ? 1 : 2)
      assert.ok(result.myNotifications.items.every((item) => item.recipientId === alice.id))
      pagedIds.push(...result.myNotifications.items.map((item) => item.id))
    }
    assert.equal(pagedIds.length, 5)
    assert.equal(new Set(pagedIds).size, 5)
    assert.deepEqual(new Set(pagedIds), new Set(created.map((item) => item.id)))
    const pageOne = await list(aliceContext, 1, 2, { field: 'type', direction: 'ASC' })
    const pageTwo = await list(aliceContext, 2, 2, { field: 'type', direction: 'ASC' })
    assert.deepEqual(
      pageOne.myNotifications.items.map((item) => item.type),
      ['BOOKING_PENDING', 'BOOKING_APPROVED'],
    )
    assert.deepEqual(
      pageTwo.myNotifications.items.map((item) => item.type),
      ['BOOKING_REJECTED', 'BOOKING_CANCELLED'],
    )
    const clamped = await list(aliceContext, 1, 1000)
    assert.equal(clamped.myNotifications.totalCount, 5)
    console.log(
      `1b. pagination pageSize=2: p1=[${pageOne.myNotifications.items.map((item) => item.type).join('|')}] p2=[${pageTwo.myNotifications.items.map((item) => item.type).join('|')}] distinctIdsAcrossPages=${new Set(pagedIds).size} pageSize=1000 clampedRows=${clamped.myNotifications.items.length}`,
    )

    const approvedOnly = await list(aliceContext, 1, 20, null, 'BOOKING_APPROVED')
    assert.equal(approvedOnly.myNotifications.totalCount, 1)
    assert.equal(approvedOnly.myNotifications.items[0]?.id, created[1]?.id)
    const unreadOnly = await list(aliceContext, 1, 20, null, null, true)
    assert.equal(unreadOnly.myNotifications.totalCount, 5)
    console.log(
      `1c. filters: type=BOOKING_APPROVED totalCount=${approvedOnly.myNotifications.totalCount} unreadOnly totalCount=${unreadOnly.myNotifications.totalCount}`,
    )

    // --- 2. unreadCount reflects only unread notifications --------------------
    const aliceUnread = requireData<{ unreadCount: number }>(
      await graphql({ schema, source: unreadQuery, contextValue: aliceContext }),
    )
    const bobUnread = requireData<{ unreadCount: number }>(
      await graphql({ schema, source: unreadQuery, contextValue: bobContext }),
    )
    assert.equal(aliceUnread.unreadCount, 5)
    assert.equal(bobUnread.unreadCount, 1)
    console.log(`2. unreadCount: alice=${aliceUnread.unreadCount} bob=${bobUnread.unreadCount}`)

    // --- 3. markRead on one notification --------------------------------------
    const target = created[0]
    if (target === undefined) {
      throw new Error('expected at least one created notification')
    }
    const markRead = requireData<{ markNotificationRead: { id: string; isRead: boolean } }>(
      await graphql({
        schema,
        source: markReadMutation,
        contextValue: aliceContext,
        variableValues: { id: target.id },
      }),
    )
    assert.equal(markRead.markNotificationRead.id, target.id)
    assert.equal(markRead.markNotificationRead.isRead, true)
    const afterMarkRead = requireData<{ unreadCount: number }>(
      await graphql({ schema, source: unreadQuery, contextValue: aliceContext }),
    )
    assert.equal(afterMarkRead.unreadCount, 4)
    const afterMarkReadList = await list(aliceContext, 1, 20, { field: 'type', direction: 'ASC' })
    const byId = new Map(afterMarkReadList.myNotifications.items.map((item) => [item.id, item] as const))
    assert.equal(byId.get(target.id)?.isRead, true)
    const unaffected = afterMarkReadList.myNotifications.items.filter((item) => item.id !== target.id)
    assert.equal(unaffected.length, 4)
    assert.ok(unaffected.every((item) => item.isRead === false))
    const idempotent = requireData<{ markNotificationRead: { id: string; isRead: boolean } }>(
      await graphql({
        schema,
        source: markReadMutation,
        contextValue: aliceContext,
        variableValues: { id: target.id },
      }),
    )
    assert.equal(idempotent.markNotificationRead.isRead, true)
    const afterIdempotent = requireData<{ unreadCount: number }>(
      await graphql({ schema, source: unreadQuery, contextValue: aliceContext }),
    )
    assert.equal(afterIdempotent.unreadCount, 4)
    const unreadAfterMarkRead = await list(aliceContext, 1, 20, null, null, true)
    assert.equal(unreadAfterMarkRead.myNotifications.totalCount, 4)
    assert.ok(!unreadAfterMarkRead.myNotifications.items.some((item) => item.id === target.id))
    console.log(
      `3. markRead: ${target.type} id=${target.id} isRead=${markRead.markNotificationRead.isRead} aliceUnread=${afterMarkRead.unreadCount} otherUnread=${unaffected.filter((item) => item.isRead === false).length} idempotentReReadUnread=${afterIdempotent.unreadCount}`,
    )

    // --- 4. markAllRead -------------------------------------------------------
    const markAll = requireData<{ markAllNotificationsRead: number }>(
      await graphql({ schema, source: markAllReadMutation, contextValue: aliceContext }),
    )
    assert.equal(markAll.markAllNotificationsRead, 4)
    const afterMarkAllUnread = requireData<{ unreadCount: number }>(
      await graphql({ schema, source: unreadQuery, contextValue: aliceContext }),
    )
    assert.equal(afterMarkAllUnread.unreadCount, 0)
    const afterMarkAllList = await list(aliceContext, 1, 20)
    assert.equal(afterMarkAllList.myNotifications.totalCount, 5)
    assert.ok(afterMarkAllList.myNotifications.items.every((item) => item.isRead === true))
    const bobAfterMarkAll = requireData<{ unreadCount: number }>(
      await graphql({ schema, source: unreadQuery, contextValue: bobContext }),
    )
    assert.equal(bobAfterMarkAll.unreadCount, 1)
    const bobList = await list(bobContext)
    assert.equal(bobList.myNotifications.totalCount, 1)
    assert.equal(bobList.myNotifications.items[0]?.isRead, false)
    const markAllAgain = requireData<{ markAllNotificationsRead: number }>(
      await graphql({ schema, source: markAllReadMutation, contextValue: aliceContext }),
    )
    assert.equal(markAllAgain.markAllNotificationsRead, 0)
    console.log(
      `4. markAllRead: updatedRows=${markAll.markAllNotificationsRead} aliceUnread=${afterMarkAllUnread.unreadCount} allRead=${afterMarkAllList.myNotifications.items.every((item) => item.isRead)} bobUnreadUnaffected=${bobAfterMarkAll.unreadCount} secondRunRows=${markAllAgain.markAllNotificationsRead}`,
    )

    // --- 5. user A cannot mark or read user B's notifications ------------------
    const crossMark = await graphql({
      schema,
      source: markReadMutation,
      contextValue: aliceContext,
      variableValues: { id: bobs.id },
    })
    const crossError = firstError(crossMark)
    assert.equal(crossMark.data?.markNotificationRead, undefined)
    assert.equal(crossError.name, 'NotFoundError')
    assert.equal(crossError.message, 'Notification not found')
    const bobRowAfterCross = await notificationRepository.findOne({ where: { id: bobs.id } })
    assert.equal(bobRowAfterCross?.isRead, false)
    const bobUnreadAfterCross = requireData<{ unreadCount: number }>(
      await graphql({ schema, source: unreadQuery, contextValue: bobContext }),
    )
    assert.equal(bobUnreadAfterCross.unreadCount, 1)
    const aliceListAfterCross = await list(aliceContext, 1, 20)
    assert.ok(!aliceListAfterCross.myNotifications.items.some((item) => item.id === bobs.id))
    assert.ok(!JSON.stringify(aliceListAfterCross).includes(bobs.title), 'another user title leaked')
    assert.ok(!JSON.stringify(aliceListAfterCross).includes(bobs.message), 'another user message leaked')

    const missing = await graphql({
      schema,
      source: markReadMutation,
      contextValue: aliceContext,
      variableValues: { id: randomUUID() },
    })
    const missingError = firstError(missing)
    assert.equal(missingError.name, 'NotFoundError')
    assert.equal(missingError.message, 'Notification not found')

    const anonymousList = await graphql({
      schema,
      source: listQuery,
      contextValue: anonymousContext,
      variableValues: { page: 1, pageSize: 20, sort: null, type: null, unreadOnly: null },
    })
    const anonymousError = firstError(anonymousList)
    assert.equal(anonymousError.name, 'AuthorisationError')
    assert.equal(anonymousError.message, 'Not authorised')
    console.log(
      `5. cross-user: alice→bob id error="${crossError.message}" (${crossError.name}) bobRowStillUnread=${bobRowAfterCross?.isRead === false} bobUnread=${bobUnreadAfterCross.unreadCount} bobsRowLeakedToAlice=${aliceListAfterCross.myNotifications.items.some((item) => item.id === bobs.id)} unknownId="${missingError.message}" anonymous="${anonymousError.message}"`,
    )

    // --- extras: the service shares the caller's transaction, and FR-75's unique index holds
    let forcedRollback = false
    try {
      await runInTransaction(dataSource, async (manager) => {
        await service.create(manager, {
          recipientId: alice.id,
          bookingId: rollbackBooking.id,
          type: 'REMINDER',
          title: 'rolled back',
          message: 'rolled back',
        })
        throw new Error('forced notification rollback')
      })
    } catch (error) {
      forcedRollback = error instanceof Error && error.message === 'forced notification rollback'
    }
    assert.equal(forcedRollback, true, 'rollback transaction did not throw as expected')
    const rollbackRows = await notificationRepository.count({
      where: { recipientId: alice.id, bookingId: rollbackBooking.id },
    })
    assert.equal(rollbackRows, 0)

    const committed = await runInTransaction(dataSource, (manager) =>
      service.create(manager, {
        recipientId: alice.id,
        bookingId: rollbackBooking.id,
        type: 'REMINDER',
        title: 'committed',
        message: 'committed',
      }),
    )
    const committedRows = await notificationRepository.count({
      where: { recipientId: alice.id, bookingId: rollbackBooking.id },
    })
    assert.equal(committedRows, 1)
    assert.equal(committed.isRead, false)

    let duplicateError = ''
    try {
      await service.create(dataSource.manager, {
        recipientId: alice.id,
        bookingId: rollbackBooking.id,
        type: 'REMINDER',
        title: 'duplicate',
        message: 'duplicate',
      })
    } catch (error) {
      duplicateError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    assert.match(duplicateError, /^ConflictError: /)
    const afterDuplicate = await list(aliceContext, 1, 20)
    assert.equal(afterDuplicate.myNotifications.totalCount, 6)
    console.log(
      `6. transaction+uniqueness: rolledBackRows=${rollbackRows} committedRows=${committedRows} duplicate="${duplicateError}"`,
    )

    // --- 7-12: FR-57 / FR-58 wiring into the booking lifecycle, fired via afterCommit ---
    const roleRepository = dataSource.getRepository(Role)
    const userRoleRepository = dataSource.getRepository(UserRole)
    const managerRole = await roleRepository.findOneByOrFail({ roleName: 'Manager' })
    const lifecycleRoom = await roomRepository.save(
      roomRepository.create({
        name: `Lifecycle room ${runId}`,
        location: `Lab ${runId}`,
        capacity: 20,
        isActive: true,
      }),
    )
    lifecycleRoomId = lifecycleRoom.id
    const lifecycleEmployees = await employeeRepository.save([
      employeeRepository.create({
        firstName: `Rae${runId}`,
        lastName: 'Requester',
        email: `rae-${runId}@example.test`,
        password: '$2b$12$notification.acceptance.password.hash.0000000000000000000000',
      }),
      employeeRepository.create({
        firstName: `Mo${runId}`,
        lastName: 'Manager',
        email: `mo-${runId}@example.test`,
        password: '$2b$12$notification.acceptance.password.hash.0000000000000000000000',
      }),
      employeeRepository.create({
        firstName: `Nia${runId}`,
        lastName: 'Manager',
        email: `nia-${runId}@example.test`,
        password: '$2b$12$notification.acceptance.password.hash.0000000000000000000000',
      }),
    ])
    const [requester, fixtureManagerOne, fixtureManagerTwo] = lifecycleEmployees
    if (requester === undefined || fixtureManagerOne === undefined || fixtureManagerTwo === undefined) {
      throw new Error('Notification lifecycle employee fixture creation returned too few rows')
    }
    employeeIds.push(requester.id, fixtureManagerOne.id, fixtureManagerTwo.id)
    await userRoleRepository.save([
      userRoleRepository.create({ employeeId: fixtureManagerOne.id, roleId: managerRole.id }),
      userRoleRepository.create({ employeeId: fixtureManagerTwo.id, roleId: managerRole.id }),
    ])

    const bookingService = new BookingService(dataSource)
    const lifecycleBase = Date.now() + 30 * 24 * 60 * 60 * 1000
    let lifecycleOffset = 0
    const windowFor = (): { startTime: Date; endTime: Date } => {
      lifecycleOffset += 1
      const startTime = new Date(lifecycleBase + lifecycleOffset * 86400000)
      return { startTime, endTime: new Date(startTime.getTime() + 3600000) }
    }
    const submitBooking = async (employeeId: string, purpose: string) => {
      const win = windowFor()
      const booking = await bookingService.createBooking(employeeId, {
        roomId: lifecycleRoom.id,
        startTime: win.startTime,
        endTime: win.endTime,
        purpose,
        numberOfAttendees: 2,
      })
      lifecycleBookingIds.push(booking.id)
      return booking
    }
    const rowsFor = async (bookingId: string): Promise<Notification[]> =>
      notificationRepository.find({ where: { bookingId }, order: { createdAt: 'ASC' } })
    const expectedApproverIds = await new NotificationRepository()
      .findApproverEmployeeIds(dataSource.manager, requester.id)
      .then((ids) => new Set(ids))

    // 7 — FR-58: a new PENDING booking notifies every booking:approve holder
    const pendingBooking = await submitBooking(requester.id, `Lifecycle pending ${runId}`)
    const afterCreate = await rowsFor(pendingBooking.id)
    assert.equal(afterCreate.length, expectedApproverIds.size)
    assert.ok(afterCreate.every((row) => row.type === 'BOOKING_PENDING'))
    assert.ok(afterCreate.every((row) => row.isRead === false))
    assert.deepEqual(
      new Set(afterCreate.map((row) => row.recipientId)),
      expectedApproverIds,
    )
    for (const managerId of [fixtureManagerOne.id, fixtureManagerTwo.id]) {
      assert.ok(
        afterCreate.some((row) => row.recipientId === managerId),
        `expected a BOOKING_PENDING notification for manager ${managerId}`,
      )
    }
    assert.ok(
      !afterCreate.some((row) => row.recipientId === requester.id),
      'the requester must not be notified about their own request',
    )
    console.log(
      `7. FR-58 create→managers: booking=${pendingBooking.id} notifications=${afterCreate.length} approversHolders=${expectedApproverIds.size} bothFixtureManagersNotified=${[fixtureManagerOne.id, fixtureManagerTwo.id].every((id) => afterCreate.some((row) => row.recipientId === id))} requesterNotified=${afterCreate.some((row) => row.recipientId === requester.id)}`,
    )

    // 8 — FR-57: approval notifies the requester only
    await bookingService.approveBooking(fixtureManagerOne.id, pendingBooking.id)
    const afterApprove = await rowsFor(pendingBooking.id)
    const approvedNotice = afterApprove.find((row) => row.type === 'BOOKING_APPROVED')
    assert.ok(approvedNotice !== undefined, 'expected a BOOKING_APPROVED notification')
    assert.equal(approvedNotice.recipientId, requester.id)
    assert.equal(approvedNotice.isRead, false)
    assert.equal(afterApprove.length, expectedApproverIds.size + 1)
    assert.match(approvedNotice.message, /approved/)
    console.log(
      `8. FR-57 approve→requester: booking=${pendingBooking.id} type=${approvedNotice.type} recipientIsRequester=${approvedNotice.recipientId === requester.id} rowsForBooking=${afterApprove.length} (was ${expectedApproverIds.size})`,
    )

    // 9 — FR-57: rejection notifies the requester and carries the reason
    const rejectTarget = await submitBooking(requester.id, `Lifecycle reject ${runId}`)
    const rejectReason = 'Room is held for the quarterly all-hands'
    await bookingService.rejectBooking(fixtureManagerTwo.id, rejectTarget.id, rejectReason)
    const afterReject = await rowsFor(rejectTarget.id)
    const rejectedNotice = afterReject.find((row) => row.type === 'BOOKING_REJECTED')
    assert.ok(rejectedNotice !== undefined, 'expected a BOOKING_REJECTED notification')
    assert.equal(rejectedNotice.recipientId, requester.id)
    assert.ok(rejectedNotice.message.includes(rejectReason), 'the rejection reason must reach the notification')
    assert.equal(afterReject.length, expectedApproverIds.size + 1)
    console.log(
      `9. FR-57 reject→requester: booking=${rejectTarget.id} type=${rejectedNotice.type} reasonInMessage=${rejectedNotice.message.includes(rejectReason)} rowsForBooking=${afterReject.length}`,
    )

    // 10 — FR-57: a manager cancelling someone else's booking notifies the requester
    const cancelTarget = await submitBooking(requester.id, `Lifecycle manager cancel ${runId}`)
    await bookingService.approveBooking(fixtureManagerOne.id, cancelTarget.id)
    await bookingService.cancelAnyBooking(fixtureManagerTwo.id, cancelTarget.id)
    const afterManagerCancel = await rowsFor(cancelTarget.id)
    const cancelledNotice = afterManagerCancel.find((row) => row.type === 'BOOKING_CANCELLED')
    assert.ok(cancelledNotice !== undefined, 'expected a BOOKING_CANCELLED notification')
    assert.equal(cancelledNotice.recipientId, requester.id)
    assert.equal(afterManagerCancel.length, expectedApproverIds.size + 2)
    console.log(
      `10. FR-57 manager-cancel→requester: booking=${cancelTarget.id} type=${cancelledNotice.type} recipientIsRequester=${cancelledNotice.recipientId === requester.id} rowsForBooking=${afterManagerCancel.length} (pending+approved+cancelled)`,
    )

    // 11 — FR-57 excludes self-cancellation: the owner gets nothing
    const selfCancelTarget = await submitBooking(requester.id, `Lifecycle self cancel ${runId}`)
    const beforeSelfCancel = await rowsFor(selfCancelTarget.id)
    await bookingService.cancelOwnBooking(requester.id, selfCancelTarget.id)
    const afterSelfCancel = await rowsFor(selfCancelTarget.id)
    assert.equal(afterSelfCancel.length, beforeSelfCancel.length)
    assert.ok(!afterSelfCancel.some((row) => row.recipientId === requester.id))
    assert.ok(!afterSelfCancel.some((row) => row.type === 'BOOKING_CANCELLED'))
    const requesterUnreadAfterSelfCancel = requireData<{ unreadCount: number }>(
      await graphql({
        schema,
        source: unreadQuery,
        contextValue: contextFor(requester),
      }),
    )
    console.log(
      `11. FR-57 self-cancel: booking=${selfCancelTarget.id} rowsBefore=${beforeSelfCancel.length} rowsAfter=${afterSelfCancel.length} cancelledNotices=${afterSelfCancel.filter((row) => row.type === 'BOOKING_CANCELLED').length} requesterUnreadCount=${requesterUnreadAfterSelfCancel.unreadCount}`,
    )

    // 12 — FR-90: a rolled-back booking transaction must produce no notification
    const rollbackTarget = await submitBooking(requester.id, `Lifecycle rollback ${runId}`)
    const beforeFailedApproval = await rowsFor(rollbackTarget.id)
    assert.equal(beforeFailedApproval.length, expectedApproverIds.size)
    await dataSource.query('UPDATE meeting_room SET is_active = false WHERE id = $1', [lifecycleRoom.id])
    let approvalFailure = ''
    try {
      await bookingService.approveBooking(fixtureManagerOne.id, rollbackTarget.id)
    } catch (error: unknown) {
      approvalFailure = error instanceof Error ? error.message : String(error)
    }
    assert.match(approvalFailure, /room is inactive/)
    assert.equal(
      (await bookingRepository.findOneByOrFail({ id: rollbackTarget.id })).status,
      'PENDING',
      'a failed re-validation must leave the booking PENDING',
    )
    const afterFailedApproval = await rowsFor(rollbackTarget.id)
    assert.equal(afterFailedApproval.length, beforeFailedApproval.length)
    assert.ok(!afterFailedApproval.some((row) => row.type === 'BOOKING_APPROVED'))
    const approveAudits = await dataSource.query(
      'SELECT count(*)::int AS c FROM audit_log WHERE booking_id = $1 AND action = $2',
      [rollbackTarget.id, 'APPROVE'],
    )
    assert.equal(approveAudits[0]?.c, 0)
    await dataSource.query('UPDATE meeting_room SET is_active = true WHERE id = $1', [lifecycleRoom.id])
    console.log(
      `12. FR-90 rollback: booking=${rollbackTarget.id} approvalError="${approvalFailure}" notificationsBefore=${beforeFailedApproval.length} notificationsAfter=${afterFailedApproval.length} approvedNotices=${afterFailedApproval.filter((row) => row.type === 'BOOKING_APPROVED').length} approveAuditRows=${String(approveAudits[0]?.c)}`,
    )

    // 13 — a failing post-commit notification write must not roll back the booking
    class FailingNotificationService extends NotificationService {
      override async notifyApprovers(
        manager: EntityManager,
        details: BookingNotificationDetails & { requesterId: string },
      ): Promise<NotificationRecordType[]> {
        void manager
        void details
        throw new Error('notification provider unavailable')
      }
    }
    const isolatedService = new BookingService(
      dataSource,
      undefined,
      undefined,
      new FailingNotificationService(),
    )
    const isolatedBooking = await isolatedService.createBooking(requester.id, {
      roomId: lifecycleRoom.id,
      ...windowFor(),
      purpose: `Lifecycle notification failure ${runId}`,
      numberOfAttendees: 2,
    })
    lifecycleBookingIds.push(isolatedBooking.id)
    const isolatedRows = await rowsFor(isolatedBooking.id)
    assert.equal(isolatedBooking.status, 'PENDING')
    assert.equal(
      (await bookingRepository.findOneByOrFail({ id: isolatedBooking.id })).status,
      'PENDING',
      'a failed notification write must leave the booking committed',
    )
    assert.equal(isolatedRows.length, 0, 'the failed write must leave no partial notification rows')
    const createAudits = await dataSource.query(
      'SELECT count(*)::int AS c FROM audit_log WHERE booking_id = $1 AND action = $2',
      [isolatedBooking.id, 'CREATE'],
    )
    assert.equal(createAudits[0]?.c, 1)
    console.log(
      `13. post-commit failure isolation: booking=${isolatedBooking.id} status=${isolatedBooking.status} auditRows=${String(createAudits[0]?.c)} notificationRows=${isolatedRows.length} (write runs outside the booking transaction)`,
    )

    console.log('PASS notification acceptance')
  } finally {
    if (lifecycleBookingIds.length > 0) {
      await dataSource.getRepository(BookingEquipment).delete({ bookingId: In(lifecycleBookingIds) })
      await dataSource.getRepository(AuditLog).delete({ bookingId: In(lifecycleBookingIds) })
      await notificationRepository.delete({ bookingId: In(lifecycleBookingIds) })
    }
    if (employeeIds.length > 0) {
      await notificationRepository.delete({ recipientId: In(employeeIds) })
      // The outbox is addressed, not linked: scope it by the fixture employees'
      // own addresses, before those rows disappear.
      await dataSource.getRepository(EmailOutbox).delete({
        toEmail: In(
          (
            await employeeRepository
              .createQueryBuilder('employee')
              .select('employee.email', 'email')
              .where('employee.id IN (:...ids)', { ids: employeeIds })
              .getRawMany<{ email: string }>()
          ).map((row) => row.email),
        ),
      })
    }
    if (lifecycleBookingIds.length > 0) {
      await bookingRepository.delete({ id: In(lifecycleBookingIds) })
    }
    if (bookingIds.length > 0) {
      await bookingRepository.delete({ id: In(bookingIds) })
    }
    if (lifecycleRoomId !== null) {
      await roomRepository.delete({ id: lifecycleRoomId })
    }
    if (roomId !== null) {
      await roomRepository.delete({ id: roomId })
    }
    if (employeeIds.length > 0) {
      await employeeRepository.delete({ id: In(employeeIds) })
    }
    await dataSource.destroy()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
