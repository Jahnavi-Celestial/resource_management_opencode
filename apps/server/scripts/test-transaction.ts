import 'reflect-metadata'
import type { DataSource } from 'typeorm'
import { loadEnv } from '../src/config/env'
import { createDataSource } from '../src/config/data-source'
import { runInTransaction } from '../src/common/db/transaction'
import { Employee } from '../src/modules/employee/employee.entity'

const ROLLBACK_EMAIL = 'tx.rollback@local.test'
const COMMIT_EMAIL = 'tx.commit@local.test'
const FIXTURE_PASSWORD = 'not-a-real-hash'

let failures = 0

function log(line: string): void {
  console.log(line)
}

function check(name: string, condition: boolean, evidence: string): void {
  if (condition) {
    log(`  [PASS] ${name}`)
    if (evidence !== '') log(`         ${evidence}`)
  } else {
    failures += 1
    log(`  [FAIL] ${name} — ${evidence}`)
  }
}

async function employeeCountByEmail(dataSource: DataSource, email: string): Promise<number> {
  return dataSource.getRepository(Employee).count({ where: { email } })
}

async function cleanupFixtures(dataSource: DataSource): Promise<void> {
  await dataSource.getRepository(Employee).delete({ email: ROLLBACK_EMAIL })
  await dataSource.getRepository(Employee).delete({ email: COMMIT_EMAIL })
}

async function test1ForcedRollback(dataSource: DataSource): Promise<void> {
  log('TEST 1 — a throw inside the transaction rolls back; afterCommit fires zero times')
  let callbackRuns = 0
  let caught: unknown
  try {
    await runInTransaction(dataSource, async (tx) => {
      await tx.getRepository(Employee).save({
        firstName: 'Tx',
        lastName: 'Rollback',
        email: ROLLBACK_EMAIL,
        password: FIXTURE_PASSWORD,
      } as Employee)
      tx.afterCommit(() => {
        callbackRuns += 1
      })
      throw new Error('forced failure after the write')
    })
  } catch (error: unknown) {
    caught = error
  }
  check(
    'the original error is rethrown to the caller, not swallowed',
    caught instanceof Error && caught.message === 'forced failure after the write',
    caught instanceof Error ? `caught: "${caught.message}"` : 'no error thrown',
  )
  check(
    'afterCommit callback fired zero times on rollback',
    callbackRuns === 0,
    `callback runs=${String(callbackRuns)}`,
  )
  const rollbackCount = await employeeCountByEmail(dataSource, ROLLBACK_EMAIL)
  check(
    'the write made inside the rolled-back transaction is not observable (NFR-3)',
    rollbackCount === 0,
    `employee rows with email=${ROLLBACK_EMAIL}: ${String(rollbackCount)}`,
  )
}

async function test2CommitFiresOnce(dataSource: DataSource): Promise<void> {
  log('TEST 2 — a committing transaction fires each afterCommit callback exactly once, after the commit')
  let firstRuns = 0
  let secondRuns = 0
  const order: string[] = []
  let visibleOutsideDuringTransaction = -1
  let visibleOutsideInsideCallback = -1
  const returned = await runInTransaction(dataSource, async (tx) => {
    await tx.getRepository(Employee).save({
      firstName: 'Tx',
      lastName: 'Commit',
      email: COMMIT_EMAIL,
      password: FIXTURE_PASSWORD,
    } as Employee)
    visibleOutsideDuringTransaction = await employeeCountByEmail(dataSource, COMMIT_EMAIL)
    tx.afterCommit(() => {
      firstRuns += 1
      order.push('first')
    })
    tx.afterCommit(async () => {
      secondRuns += 1
      order.push('second')
      visibleOutsideInsideCallback = await employeeCountByEmail(dataSource, COMMIT_EMAIL)
    })
    return 'commit-result'
  })
  check(
    "fn's return value propagates out of runInTransaction",
    returned === 'commit-result',
    `returned=${JSON.stringify(returned)}`,
  )
  check(
    'the row is invisible on a separate connection while the transaction is still open',
    visibleOutsideDuringTransaction === 0,
    `rows visible outside tx before commit: ${String(visibleOutsideDuringTransaction)}`,
  )
  check(
    'each callback fired exactly once, in registration order',
    firstRuns === 1 && secondRuns === 1 && order.join(',') === 'first,second',
    `first=${String(firstRuns)}, second=${String(secondRuns)}, order=${order.join(',')}`,
  )
  check(
    'callbacks ran after the commit — the row is already visible on a separate connection',
    visibleOutsideInsideCallback === 1,
    `rows visible inside callback: ${String(visibleOutsideInsideCallback)}`,
  )
  const commitCount = await employeeCountByEmail(dataSource, COMMIT_EMAIL)
  check(
    'the write is durably committed',
    commitCount === 1,
    `employee rows with email=${COMMIT_EMAIL}: ${String(commitCount)}`,
  )
}

async function main(): Promise<void> {
  const env = loadEnv()
  const dataSource = createDataSource()
  await dataSource.initialize()
  await cleanupFixtures(dataSource)
  log(`transaction test — pid ${process.pid}, db ${env.db.name}`)
  log('')

  try {
    await test1ForcedRollback(dataSource)
    log('')
    await test2CommitFiresOnce(dataSource)
  } finally {
    await cleanupFixtures(dataSource)
    await dataSource.destroy()
  }

  log('')
  if (failures === 0) {
    log('RESULT: all runInTransaction/afterCommit checks passed')
    process.exit(0)
  }
  log(`RESULT: ${failures} check(s) FAILED`)
  process.exit(1)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`transaction test crashed: ${message}`)
  process.exit(1)
})
