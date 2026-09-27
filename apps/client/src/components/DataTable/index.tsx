import { useEffect, useMemo, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import LinearProgress from '@mui/material/LinearProgress'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import { DataGrid, type GridColDef, type GridSortModel, type GridValidRowModel } from '@mui/x-data-grid'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import {
  TABLE_PAGE_SIZES,
  type ColumnFilter,
  type DataTableColumn,
  type DataTableProps,
  type FilterValue,
  type TableState,
} from './types'

/**
 * The one list component. NFR-7: pagination, search, sort and filter are all
 * *server-side*, so the grid runs in `…Mode="server"` for all three and is given
 * a `rowCount` rather than a complete data set.
 *
 * It issues no query and knows no entity. Everything entity-specific arrives as
 * props: the columns (so a new screen adds no code here), the current
 * `TableState`, and `onStateChange`, which reports what the user did in the same
 * shape as the API's list arguments — `sort` is already `{ field, direction }`
 * with the API's field name and an `ASC`/`DESC` direction, and every filter is
 * keyed by the *argument* it feeds (`minCapacity`, `activeOnly`). The screen's
 * only job is turning that state into the variables of its own query.
 */

const ACTIONS_FIELD = '__actions'

function defaultGetRowId<Row>(row: Row): string {
  const id = (row as { id?: unknown }).id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : ''
}

function parseFilterValue(filter: ColumnFilter, raw: string): FilterValue | null {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return null
  }
  if (filter.type === 'number') {
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return trimmed
}

export function DataTable<Row extends GridValidRowModel>({
  rows,
  columns,
  totalCount,
  state,
  onStateChange,
  loading = false,
  searchable = true,
  searchPlaceholder = 'Search',
  searchDebounceMs = 300,
  getRowId = defaultGetRowId,
  actions,
  actionsHeader = 'Actions',
  toolbar,
  emptyMessage = 'No rows',
}: DataTableProps<Row>): React.ReactElement {
  // `onStateChange` and the latest state are read through refs inside the
  // debounce effects, so a keystroke is not cancelled by an unrelated re-render
  // (or re-fired because the parent passes a fresh object literal each time).
  const stateRef = useRef(state)
  stateRef.current = state
  const changeRef = useRef(onStateChange)
  changeRef.current = onStateChange

  const [searchDraft, setSearchDraft] = useState(state.search)
  const debouncedSearch = useDebouncedValue(searchDraft, searchDebounceMs)
  // The last value this component and the screen have *agreed* on. "Agreed on"
  // is the whole point: comparing a keystroke against `state.search` alone
  // mistakes the user's first character (still in the debounce, not yet in
  // `state`) for an external reset and throws it away.
  const agreedSearch = useRef(state.search)

  const filters = useMemo(() => columns.flatMap((column) => column.filters ?? []), [columns])
  const [filterDrafts, setFilterDrafts] = useState<Readonly<Record<string, string>>>({})
  const debouncedDrafts = useDebouncedValue(filterDrafts, searchDebounceMs)
  const pushedDrafts = useRef<string | null>(null)

  // Adopt a search value the screen changed from outside, and only that: the
  // `state.search` identity is what says "somebody else did this", so a
  // keystroke in flight can never be mistaken for one.
  useEffect(() => {
    if (state.search === agreedSearch.current) {
      return
    }
    agreedSearch.current = state.search
    setSearchDraft(state.search)
  }, [state.search])

  useEffect(() => {
    if (debouncedSearch === stateRef.current.search) {
      return
    }
    agreedSearch.current = debouncedSearch
    changeRef.current({ ...stateRef.current, page: 0, search: debouncedSearch })
  }, [debouncedSearch])

  useEffect(() => {
    const raw = JSON.stringify(debouncedDrafts)
    if (pushedDrafts.current === raw) {
      return
    }
    pushedDrafts.current = raw
    const next: Record<string, FilterValue> = { ...stateRef.current.filters }
    let changed = false
    for (const filter of filters) {
      // A boolean filter is applied the instant it is toggled, so it has no
      // draft to reconcile. Reconciling it against its (always empty) draft
      // would delete the value the user just set the moment any *other* filter
      // is typed — a silent, order-dependent loss of a filter.
      if (filter.type === 'boolean') {
        continue
      }
      const value = parseFilterValue(filter, debouncedDrafts[filter.key] ?? '')
      const current = next[filter.key]
      if (value === null) {
        if (current !== undefined) {
          delete next[filter.key]
          changed = true
        }
      } else if (current !== value) {
        next[filter.key] = value
        changed = true
      }
    }
    if (changed) {
      changeRef.current({ ...stateRef.current, page: 0, filters: next })
    }
  }, [debouncedDrafts, filters])

  // The grid's own sort model speaks DataGrid field names; the API speaks the
  // `sortField` the screen declared. Both directions are needed: render the
  // server's sort as the right arrow on the right column, and translate a click.
  const gridFieldForSortField = useMemo(
    () => new Map(columns.flatMap((column) => (column.sortField === undefined ? [] : [[column.sortField, column.field] as const]))),
    [columns],
  )
  const sortModel = useMemo<GridSortModel>(() => {
    const sort = state.sort
    if (sort === null) {
      return []
    }
    const field = gridFieldForSortField.get(sort.field)
    if (field === undefined) {
      return []
    }
    return [{ field, sort: sort.direction === 'ASC' ? 'asc' : 'desc' }]
  }, [gridFieldForSortField, state.sort])

  const gridColumns = useMemo<GridColDef<Row>[]>(() => {
    const base: GridColDef<Row>[] = columns.map((column: DataTableColumn<Row>) => ({
      field: column.field,
      headerName: column.headerName,
      // A column with no `sortField` is inert: the endpoint cannot sort by it.
      sortable: column.sortField !== undefined,
      filterable: false,
      disableColumnMenu: true,
      ...(column.width === undefined ? {} : { width: column.width }),
      ...(column.minWidth === undefined ? {} : { minWidth: column.minWidth }),
      ...(column.flex === undefined ? {} : { flex: column.flex }),
      ...(column.align === undefined ? {} : { align: column.align, headerAlign: column.align }),
      ...(column.type === undefined ? {} : { type: column.type }),
    }))
    if (actions === undefined) {
      return base
    }
    return [
      ...base,
      {
        field: ACTIONS_FIELD,
        headerName: actionsHeader,
        sortable: false,
        filterable: false,
        disableColumnMenu: true,
        width: 120,
        align: 'right',
        headerAlign: 'right',
        renderCell: (params) => <>{actions(params.row)}</>,
      },
    ]
  }, [actions, actionsHeader, columns])

  const hasFilters = filters.length > 0
  const activeFilterCount = Object.keys(state.filters).length

  return (
    <Box data-testid="datatable" data-component="DataTable">
      {loading && <LinearProgress data-testid="table-loading" />}

      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        useFlexGap
        sx={{
          alignItems: { xs: 'stretch', md: 'center' },
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          mb: 2,
        }}
      >
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          {toolbar}
          <Typography variant="body2" color="text.secondary" data-testid="table-total">
            {String(totalCount)} total
          </Typography>
        </Stack>
        {searchable && (
          <TextField
            size="small"
            label={searchPlaceholder}
            // The testid belongs to the <input>: a test that types, clears or
            // reads a value must never have to reach through a wrapper.
            slotProps={{ htmlInput: { 'data-testid': 'table-search' } }}
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            sx={{ minWidth: 240 }}
          />
        )}
      </Stack>

      {hasFilters && (
        <Stack
          direction="row"
          spacing={2}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 2 }}
          data-testid="table-filters"
        >
          {filters.map((filter) =>
            filter.type === 'boolean' ? (
              <FormControlLabel
                key={filter.key}
                control={
                  <Checkbox
                    // No testid here: a boolean filter is reached by its
                    // accessible name (`getByLabelText`), which is what a
                    // screen reader and a test both use.
                    checked={state.filters[filter.key] === true}
                    onChange={(event) => {
                      changeRef.current({
                        ...stateRef.current,
                        page: 0,
                        filters: { ...stateRef.current.filters, [filter.key]: event.target.checked },
                      })
                    }}
                  />
                }
                label={filter.label}
              />
            ) : (
              <TextField
                key={filter.key}
                size="small"
                type={filter.type === 'number' ? 'number' : 'text'}
                label={filter.label}
                placeholder={filter.placeholder}
                slotProps={{ htmlInput: { 'data-testid': `filter-${filter.key}` } }}
                value={filterDrafts[filter.key] ?? ''}
                onChange={(event) =>
                  setFilterDrafts((previous) => ({ ...previous, [filter.key]: event.target.value }))
                }
                sx={{ width: 160 }}
              />
            ),
          )}
          {activeFilterCount > 0 && (
            <Button size="small" data-testid="clear-filters" onClick={() => {
              pushedDrafts.current = JSON.stringify({})
              setFilterDrafts({})
              changeRef.current({ ...stateRef.current, page: 0, filters: {} })
            }}>
              Clear filters
            </Button>
          )}
        </Stack>
      )}

      <Box sx={{ width: '100%' }}>
        <DataGrid
          rows={rows}
          columns={gridColumns}
          getRowId={getRowId}
          autoHeight
          // NFR-7: the grid never sorts, filters or paginates a local copy.
          paginationMode="server"
          sortingMode="server"
          filterMode="server"
          disableColumnFilter
          disableColumnMenu
          rowCount={totalCount}
          loading={loading}
          pageSizeOptions={[...TABLE_PAGE_SIZES]}
          paginationModel={{ page: state.page, pageSize: state.pageSize }}
          onPaginationModelChange={(model) =>
            changeRef.current({ ...stateRef.current, page: model.page, pageSize: model.pageSize })
          }
          sortModel={sortModel}
          onSortModelChange={(model) => {
            const first = model[0]
            if (first === undefined) {
              changeRef.current({ ...stateRef.current, page: 0, sort: null })
              return
            }
            const column = columns.find((candidate) => candidate.field === first.field)
            if (column?.sortField === undefined) {
              return
            }
            changeRef.current({
              ...stateRef.current,
              page: 0,
              sort: { field: column.sortField, direction: first.sort === 'desc' ? 'DESC' : 'ASC' },
            })
          }}
          localeText={{ noRowsLabel: emptyMessage }}
        />
      </Box>
    </Box>
  )
}
