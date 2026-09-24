import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm'
import { DomainError } from '../errors/domain-error'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './page-args'
import { SORT_DIRECTIONS, type SortInput, type SortableFields } from './sort-input'

export interface PageWindow {
  page: number
  pageSize: number
  skip: number
  take: number
}

export type PaginationArgs = { page?: number; pageSize?: number }

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = value === undefined || !Number.isFinite(value) ? fallback : Math.trunc(value)
  return Math.min(max, Math.max(min, raw))
}

export function resolvePageWindow(args: PaginationArgs): PageWindow {
  const page = boundedInt(args.page, 1, 1, Number.MAX_SAFE_INTEGER)
  const pageSize = boundedInt(args.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize }
}

function resolveSortColumn(sort: SortInput, sortableFields: SortableFields): string {
  const column = Object.prototype.hasOwnProperty.call(sortableFields, sort.field)
    ? sortableFields[sort.field]
    : undefined
  if (column === undefined) {
    throw new DomainError(
      `Cannot sort by "${sort.field}" — sortable fields: ${Object.keys(sortableFields).join(', ')}`,
    )
  }
  if (!(SORT_DIRECTIONS as readonly string[]).includes(sort.direction)) {
    throw new DomainError(`Invalid sort direction "${String(sort.direction)}" — allowed: ASC, DESC`)
  }
  return column
}

export function applyPagination<Entity extends ObjectLiteral>(
  qb: SelectQueryBuilder<Entity>,
  args: PaginationArgs,
  sort: SortInput | null | undefined,
  sortableFields: SortableFields,
): SelectQueryBuilder<Entity> {
  const { skip, take } = resolvePageWindow(args)
  if (sort !== null && sort !== undefined) {
    qb.orderBy(resolveSortColumn(sort, sortableFields), sort.direction)
  }
  return qb.skip(skip).take(take)
}
