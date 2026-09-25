import { randomUUID } from 'node:crypto'
import type { DataSource } from 'typeorm'
import { createDataSource } from '../../../config/data-source'
import { ConflictError } from '../../../common/errors/conflict-error'
import { BookingService } from '../booking.service'
import { Employee } from '../../employee/employee.entity'
import { Equipment } from '../../equipment/equipment.entity'
import { MeetingRoom } from '../../room/room.entity'

const ITERATIONS = 5
const CALLS_PER_SCENARIO = 8
const ROOM_CONFLICT = 'The selected room is not available for the requested time range'

type Scenario = 'room' | 'equipment'

type Fixture = {
  employeeId: string
  roomIds: string[]
  equipmentId?: string
}

type Counts = {
  booking: number
  bookingEquipment: number
  audit: number
  room: number
  employee: number
  equipment: number
}

type ErrorDetails = {
  name: string
  message: string
  codes: string[]
}

function getErrorDetails(reason: unknown): ErrorDetails {
  const codes = new Set<string>()
  const collectCodes = (value: unknown, depth: number): void => {
    if (depth > 3 || typeof value !== 'object' || value === null) {
      return
    }

    const record = value as Record<string, unknown>
    for (const key of ['code', 'sqlState']) {
      if (typeof record[key] === 'string') {
        codes.add(record[key] as string)
      }
    }
    collectCodes(record.driverError, depth + 1)
    collectCodes(record.cause, depth + 1)
  }

  collectCodes(reason, 0)
  const error = reason as {
    name?: unknown
    message?: unknown
  }
  return {
    name: typeof error?.name === 'string' ? error.name : 'UnknownError',
    message: typeof error?.message === 'string' ? error.message : String(reason),
    codes: [...codes],
  }
}

function isDeadlock(details: ErrorDetails): boolean {
  return details.codes.includes('40P01') || /deadlock detected/i.test(details.message)
}

async function createFixture(dataSource: DataSource, scenario: Scenario): Promise<Fixture> {
  const suffix = randomUUID()
  const employeeRepository = dataSource.getRepository(Employee)
  const employee = await employeeRepository.save(
    employeeRepository.create({
      firstName: 'Concurrency',
      lastName: 'Fixture',
      email: `booking-concurrency-${suffix}@example.test`,
      password: 'fixture-password',
    }),
  )

  const roomRepository = dataSource.getRepository(MeetingRoom)
  const roomIds: string[] = []
  const roomCount = scenario === 'room' ? 1 : CALLS_PER_SCENARIO
  for (let index = 0; index < roomCount; index += 1) {
    const room = await roomRepository.save(
      roomRepository.create({
        name: `Concurrency room ${suffix}-${index}`,
        location: 'Concurrency test location',
        capacity: scenario === 'room' ? 1 : 10,
        isActive: true,
      }),
    )
    roomIds.push(room.id)
  }

  if (scenario === 'equipment') {
    const equipmentRepository = dataSource.getRepository(Equipment)
    const equipment = await equipmentRepository.save(
      equipmentRepository.create({
        name: `Concurrency equipment ${suffix}`,
        quantityAvailable: 1,
        isActive: true,
      }),
    )
    return { employeeId: employee.id, roomIds, equipmentId: equipment.id }
  }

  return { employeeId: employee.id, roomIds }
}

async function cleanupFixture(dataSource: DataSource, fixture: Fixture): Promise<void> {
  await dataSource.query(
    'DELETE FROM booking_equipment WHERE booking_id IN (SELECT id FROM booking WHERE room_id = ANY($1::uuid[]))',
    [fixture.roomIds],
  )
  await dataSource.query(
    'DELETE FROM audit_log WHERE booking_id IN (SELECT id FROM booking WHERE room_id = ANY($1::uuid[]))',
    [fixture.roomIds],
  )
  await dataSource.query('DELETE FROM booking WHERE room_id = ANY($1::uuid[])', [fixture.roomIds])

  if (fixture.equipmentId !== undefined) {
    await dataSource.query('DELETE FROM equipment WHERE id = $1', [fixture.equipmentId])
  }

  await dataSource.query('DELETE FROM meeting_room WHERE id = ANY($1::uuid[])', [fixture.roomIds])
  await dataSource.query('DELETE FROM employee WHERE id = $1', [fixture.employeeId])
}

async function readCounts(dataSource: DataSource, fixture: Fixture): Promise<Counts> {
  const [row] = await dataSource.query(
    `
      SELECT
        (SELECT COUNT(*)::int FROM booking WHERE room_id = ANY($1::uuid[])) AS booking,
        (SELECT COUNT(*)::int
           FROM booking_equipment booking_equipment
           INNER JOIN booking booking ON booking.id = booking_equipment.booking_id
          WHERE booking.room_id = ANY($1::uuid[])) AS booking_equipment,
        (SELECT COUNT(*)::int
           FROM audit_log audit_log
           INNER JOIN booking booking ON booking.id = audit_log.booking_id
          WHERE booking.room_id = ANY($1::uuid[])) AS audit,
        (SELECT COUNT(*)::int FROM meeting_room WHERE id = ANY($1::uuid[])) AS room,
        (SELECT COUNT(*)::int FROM employee WHERE id = $2) AS employee,
        (SELECT COUNT(*)::int FROM equipment WHERE id = $3) AS equipment
    `,
    [fixture.roomIds, fixture.employeeId, fixture.equipmentId ?? null],
  )

  return {
    booking: Number(row.booking),
    bookingEquipment: Number(row.booking_equipment),
    audit: Number(row.audit),
    room: Number(row.room),
    employee: Number(row.employee),
    equipment: Number(row.equipment),
  }
}

function formatCounts(counts: Counts): string {
  return `booking=${counts.booking}, booking_equipment=${counts.bookingEquipment}, audit=${counts.audit}, room=${counts.room}, employee=${counts.employee}, equipment=${counts.equipment}`
}

async function runScenario(
  dataSource: DataSource,
  service: BookingService,
  scenario: Scenario,
  startTime: Date,
  endTime: Date,
  iteration: number,
): Promise<void> {
  const fixture = await createFixture(dataSource, scenario)
  const input = {
    equipment:
      fixture.equipmentId === undefined ? [] : [{ equipmentId: fixture.equipmentId, quantity: 1 }],
    startTime,
    endTime,
    purpose: `Concurrency ${scenario} ${iteration}`,
    numberOfAttendees: 1,
  }

  try {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const attempts = Array.from({ length: CALLS_PER_SCENARIO }, (_, index) =>
      gate.then(() =>
        service.createBooking(fixture.employeeId, {
          ...input,
          roomId: scenario === 'room' ? fixture.roomIds[0]! : fixture.roomIds[index]!,
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          equipment: input.equipment.map((item) => ({ ...item })),
        }),
      ),
    )

    release()
    const results = await Promise.allSettled(attempts)
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    const rejectedDetails = rejected.map((result) =>
      result.status === 'rejected' ? getErrorDetails(result.reason) : undefined,
    )
    const deadlockDetails = rejectedDetails.filter(
      (details): details is ErrorDetails => details !== undefined && isDeadlock(details),
    )
    const expectedError = scenario === 'room' ? ROOM_CONFLICT : `Equipment ${fixture.equipmentId} is not available: requested 1, 0 free`
    const errorMessages = rejectedDetails
      .map(
        (details) => `${details?.name ?? 'UnknownError'}: ${details?.message ?? 'unknown'}`,
      )
      .join(' | ')

    console.log(
      `ITERATION ${iteration}/${ITERATIONS} ${scenario.toUpperCase()} result: fulfilled=${fulfilled.length}, rejected=${rejected.length}, errors=[${errorMessages}]`,
    )
    console.log(
      `ITERATION ${iteration}/${ITERATIONS} ${scenario.toUpperCase()} deadlock_check: deadlock_detected=${deadlockDetails.length > 0}, sqlstate_40P01=${deadlockDetails.map((details) => details.codes.includes('40P01')).join(',') || 'none'}`,
    )

    if (fulfilled.length !== 1 || rejected.length !== CALLS_PER_SCENARIO - 1) {
      throw new Error(
        `${scenario} iteration ${iteration} did not produce exactly one success: ${JSON.stringify(results)}`,
      )
    }

    for (const result of rejected) {
      if (result.status !== 'rejected') {
        continue
      }
      if (!(result.reason instanceof ConflictError) || result.reason.message !== expectedError) {
        throw new Error(
          `${scenario} iteration ${iteration} returned a non-domain or unclear error: ${getErrorDetails(result.reason).message}`,
        )
      }
    }

    if (deadlockDetails.length > 0) {
      throw new Error(`${scenario} iteration ${iteration} observed PostgreSQL deadlock_detected`)
    }

    const counts = await readCounts(dataSource, fixture)
    const expectedEquipmentCount = scenario === 'equipment' ? 1 : 0
    console.log(`ITERATION ${iteration}/${ITERATIONS} ${scenario.toUpperCase()} row_counts: ${formatCounts(counts)}`)
    if (
      counts.booking !== 1 ||
      counts.bookingEquipment !== expectedEquipmentCount ||
      counts.audit !== 1
    ) {
      throw new Error(
        `${scenario} iteration ${iteration} wrote unexpected booking rows: ${formatCounts(counts)}`,
      )
    }

    console.log(
      `ITERATION ${iteration}/${ITERATIONS} ${scenario.toUpperCase()} PASS: one booking, ${CALLS_PER_SCENARIO - 1} clear domain rejections, no duplicate booking, no deadlock_detected`,
    )
  } finally {
    await cleanupFixture(dataSource, fixture)
    const counts = await readCounts(dataSource, fixture)
    console.log(`ITERATION ${iteration}/${ITERATIONS} ${scenario.toUpperCase()} cleanup: ${formatCounts(counts)}`)
    if (Object.values(counts).some((count) => count !== 0)) {
      throw new Error(`${scenario} iteration ${iteration} cleanup left fixture rows`)
    }
  }
}

async function main(): Promise<void> {
  const dataSource = createDataSource()
  await dataSource.initialize()
  const service = new BookingService(dataSource)

  try {
    for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
      const startTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + iteration * 60 * 60 * 1000)
      const endTime = new Date(startTime.getTime() + 60 * 60 * 1000)
      console.log(`ITERATION ${iteration}/${ITERATIONS} start: parallel_calls=${CALLS_PER_SCENARIO}`)
      await runScenario(dataSource, service, 'room', startTime, endTime, iteration)
      await runScenario(dataSource, service, 'equipment', startTime, endTime, iteration)
    }

    console.log(
      `CONCURRENCY_TEST PASSED: iterations=${ITERATIONS}, parallel_calls_per_scenario=${CALLS_PER_SCENARIO}`,
    )
  } finally {
    await dataSource.destroy()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
