import type { ReactNode } from 'react'
import type { GridValidRowModel } from '@mui/x-data-grid'

/**
 * The vocabulary of the server-side table. Nothing in this file mentions an
 * entity: a screen describes *what* it wants shown and filtered, and the shared
 * `DataTable` reports *what* the user did, in a shape that maps one-to-one onto
 * GraphQL list arguments.
 */

export type SortDirection = 'ASC' | 'DESC'

/** Exactly the server's `SortInput` (`field` is the API's sortable field name). */
export interface TableSort {
  field: string
  direction: SortDirection
}

export type FilterValue = string | number | boolean

/**
 * One row of list state, and everything a server-side list query needs.
 *
 * `page` is 0-based because that is what `@mui/x-data-grid` speaks; the
 * conversion to the API's 1-based `page` argument belongs to the screen, which
 * is the layer that knows the query.
 */
export interface TableState {
  page: number
  pageSize: number
  search: string
  sort: TableSort | null
  filters: Readonly<Record<string, FilterValue>>
}

export const INITIAL_TABLE_STATE: TableState = {
  page: 0,
  pageSize: 20,
  search: '',
  sort: null,
  filters: {},
}

/** The server clamps `pageSize` to 100 (NFR-2), so the UI offers nothing more. */
export const TABLE_PAGE_SIZES: readonly number[] = [10, 20, 50, 100]

export interface ColumnFilter {
  /** The *API* argument this control feeds — e.g. `minCapacity`, `activeOnly`. */
  key: string
  type: 'string' | 'number' | 'boolean'
  label: string
  placeholder?: string
}

export interface DataTableColumn<Row extends GridValidRowModel> {
  /** The property of the row object the cell reads. */
  field: string
  headerName: string
  /**
   * Present ⇒ the header is clickable and this is the field name sent to the
   * API. Absent ⇒ the column is not sortable, which is how a screen says "this
   * endpoint has no such sort" (the roles endpoint has none at all).
   */
  sortField?: string
  filters?: readonly ColumnFilter[]
  width?: number
  minWidth?: number
  flex?: number
  align?: 'left' | 'center' | 'right'
  type?: 'string' | 'number' | 'boolean'
}

export interface DataTableProps<Row extends GridValidRowModel> {
  rows: readonly Row[]
  columns: readonly DataTableColumn<Row>[]
  /** Server `totalCount`/`total` — the grid is in server pagination mode. */
  totalCount: number
  state: TableState
  onStateChange: (next: TableState) => void
  loading?: boolean
  /** Set false for endpoints with no `search` argument (roles). */
  searchable?: boolean
  searchPlaceholder?: string
  searchDebounceMs?: number
  getRowId?: (row: Row) => string
  /** Per-row controls (edit/delete). Omitted ⇒ no actions column at all. */
  actions?: (row: Row) => ReactNode
  actionsHeader?: string
  /** Caller-owned toolbar content, e.g. a "New employee" button. */
  toolbar?: ReactNode
  emptyMessage?: string
}
