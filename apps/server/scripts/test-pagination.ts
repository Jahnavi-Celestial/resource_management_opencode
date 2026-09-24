import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { DomainError } from '../src/common/errors/domain-error'
import { applyPagination } from '../src/common/pagination/apply-pagination'
import { MAX_PAGE_SIZE, PageArgs } from '../src/common/pagination/page-args'
import { SortInput } from '../src/common/pagination/sort-input'

const dataSource = new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  username: 'pagination-contract-test',
  password: 'not-used',
  database: 'not-used',
})

const EMPLOYEE_SORT_FIELDS = {
  firstName: 'employee.first_name',
  lastName: 'employee.last_name',
  email: 'employee.email',
  createdAt: 'employee.created_at',
}

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

function pageArgs(page: number, pageSize: number): PageArgs {
  const args = new PageArgs()
  args.page = page
  args.pageSize = pageSize
  return args
}

function sortInput(field: string, direction: 'ASC' | 'DESC' = 'ASC'): SortInput {
  const sort = new SortInput()
  sort.field = field
  sort.direction = direction
  return sort
}

function main(): void {
  log('Pagination contract test — offline query builder, no database connection needed')
  log('')

  log('TEST 1 — pageSize above the max clamps to the max instead of rejecting or over-fetching')
  const oversized = dataSource.createQueryBuilder()
  applyPagination(oversized, pageArgs(2, 5000), undefined, EMPLOYEE_SORT_FIELDS)
  check(
    `pageSize=5000 clamps to MAX_PAGE_SIZE=${MAX_PAGE_SIZE}`,
    oversized.expressionMap.take === MAX_PAGE_SIZE && oversized.expressionMap.skip === MAX_PAGE_SIZE,
    `take=${String(oversized.expressionMap.take)}, skip=${String(oversized.expressionMap.skip)} (page 2 × clamped size ${String(MAX_PAGE_SIZE)})`,
  )

  log('')
  log('TEST 2 — a whitelisted sort field is applied to the query builder')
  const sorted = dataSource.createQueryBuilder().orderBy('employee.created_at', 'DESC')
  applyPagination(sorted, pageArgs(1, 20), sortInput('email', 'DESC'), EMPLOYEE_SORT_FIELDS)
  check(
    "sort field 'email' maps to ORDER BY employee.email DESC, replacing the default order",
    JSON.stringify(sorted.expressionMap.orderBys) === '{"employee.email":"DESC"}',
    `orderBys=${JSON.stringify(sorted.expressionMap.orderBys)}`,
  )

  log('')
  log('TEST 3 — a non-whitelisted sort field is rejected, never silently ignored')
  const hostile = dataSource.createQueryBuilder().orderBy('employee.created_at', 'DESC')
  let thrown: unknown
  try {
    applyPagination(hostile, pageArgs(1, 20), sortInput('password'), EMPLOYEE_SORT_FIELDS)
  } catch (error: unknown) {
    thrown = error
  }
  check(
    "sort field 'password' throws a DomainError naming the field",
    thrown instanceof DomainError && thrown.message.includes('password'),
    thrown instanceof Error ? thrown.message : 'no error thrown',
  )
  check(
    'the query builder is left untouched by the rejection',
    hostile.expressionMap.skip === undefined &&
      hostile.expressionMap.take === undefined &&
      JSON.stringify(hostile.expressionMap.orderBys) === '{"employee.created_at":"DESC"}',
    `skip=${String(hostile.expressionMap.skip)}, take=${String(hostile.expressionMap.take)}, orderBys=${JSON.stringify(hostile.expressionMap.orderBys)}`,
  )

  log('')
  if (failures === 0) {
    log('RESULT: all pagination contract checks passed')
    process.exit(0)
  }
  log(`RESULT: ${failures} check(s) FAILED`)
  process.exit(1)
}

main()
