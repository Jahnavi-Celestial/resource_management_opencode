import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { DataTable } from '@/components/DataTable'
import { INITIAL_TABLE_STATE, type DataTableColumn, type FilterValue, type TableState } from '@/components/DataTable/types'
import { displayName } from '@/lib/displayName'
import { formatDateTime } from '@/lib/format'
import { AuditLogsDocument } from '../graphql/audit.graphql'
import type { AuditAction, AuditLogsQuery, AuditLogsQueryVariables, BookingStatus } from '@/graphql/graphql'

type AuditLog = AuditLogsQuery['auditLogs']['items'][number]

interface AuditRow {
  id: string
  bookingId: string
  action: string
  oldStatus: string
  newStatus: string
  actor: string
  timestamp: string
}

function toRow(log: AuditLog): AuditRow {
  return {
    id: log.id,
    bookingId: log.bookingId,
    action: log.action,
    oldStatus: log.oldStatus ?? '',
    newStatus: log.newStatus,
    actor: displayName(log.performedBy),
    timestamp: formatDateTime(log.createdAt),
  }
}

const ACTION_OPTIONS: readonly AuditAction[] = ['CREATE', 'APPROVE', 'REJECT', 'CANCEL', 'COMPLETE']
const STATUS_OPTIONS: readonly BookingStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED']

const FILTER_KEYS = ['bookingId', 'performedById', 'action', 'status', 'from', 'to'] as const

function filtersFromParams(params: URLSearchParams): Record<string, FilterValue> {
  const filters: Record<string, FilterValue> = {}
  for (const key of FILTER_KEYS) {
    const value = params.get(key)
    if (value !== null && value !== '') {
      filters[key] = value
    }
  }
  return filters
}

function paramsFromFilters(filters: Readonly<Record<string, FilterValue>>): URLSearchParams {
  const params = new URLSearchParams()
  for (const key of FILTER_KEYS) {
    const value = filters[key]
    if (value !== undefined && value !== '') {
      params.set(key, String(value))
    }
  }
  return params
}

/**
 * The audit log screen (FR-62–65). Read-only: no edit or delete controls.
 *
 * Filters live in the URL query string so a filtered view is shareable and
 * survives refresh. The URL is the single source of truth — the DataTable
 * state is derived from it, and every change writes back to it.
 */
export function AuditLogPage(): React.ReactElement {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [state, setState] = useState<TableState>(() => ({
    ...INITIAL_TABLE_STATE,
    sort: { field: 'createdAt', direction: 'DESC' },
    filters: filtersFromParams(new URLSearchParams(window.location.search)),
  }))

  const lastParamsRef = useRef<string>(window.location.search)

  useEffect(() => {
    const current = window.location.search
    if (current === lastParamsRef.current) {
      return
    }
    lastParamsRef.current = current
    setState((prev) => ({
      ...prev,
      page: 0,
      filters: filtersFromParams(new URLSearchParams(current)),
    }))
  }, [searchParams])

  const handleStateChange = useCallback(
    (next: TableState) => {
      setState(next)
      const params = paramsFromFilters(next.filters)
      const search = params.toString()
      lastParamsRef.current = search
      setSearchParams(params, { replace: true })
    },
    [setSearchParams],
  )

  const toVariables = useCallback(
    (s: TableState): AuditLogsQueryVariables => {
      const variables: AuditLogsQueryVariables = {
        page: s.page + 1,
        pageSize: s.pageSize,
      }
      const { bookingId, performedById, action, status, from, to } = s.filters
      if (typeof bookingId === 'string' && bookingId !== '') variables.bookingId = bookingId
      if (typeof performedById === 'string' && performedById !== '') variables.performedById = performedById
      if (typeof action === 'string' && action !== '') variables.action = action as AuditAction
      if (typeof status === 'string' && status !== '') variables.status = status as BookingStatus
      if (typeof from === 'string' && from !== '') variables.from = from
      if (typeof to === 'string' && to !== '') variables.to = to
      if (s.sort !== null) variables.sort = s.sort
      return variables
    },
    [],
  )

  const columns: readonly DataTableColumn<AuditRow>[] = [
    {
      field: 'timestamp',
      headerName: 'Timestamp',
      sortField: 'createdAt',
      width: 170,
      align: 'left',
      filters: [
        { key: 'from', type: 'date', label: 'From' },
        { key: 'to', type: 'date', label: 'To' },
      ],
    },
    {
      field: 'bookingId',
      headerName: 'Booking',
      width: 220,
      renderCell: (row) => (
        <Link
          component="button"
          type="button"
          variant="body2"
          sx={{ fontFamily: 'monospace', textAlign: 'left' }}
          onClick={() => navigate(`/bookings/${row.bookingId}`)}
        >
          {row.bookingId}
        </Link>
      ),
      filters: [{ key: 'bookingId', type: 'string', label: 'Booking ID', placeholder: 'UUID' }],
    },
    {
      field: 'action',
      headerName: 'Action',
      sortField: 'action',
      width: 110,
      filters: [
        {
          key: 'action',
          type: 'enum',
          label: 'Action',
          options: ACTION_OPTIONS.map((value) => ({ value, label: value })),
        },
      ],
    },
    { field: 'oldStatus', headerName: 'Old status', sortField: 'oldStatus', width: 120 },
    {
      field: 'newStatus',
      headerName: 'New status',
      sortField: 'newStatus',
      width: 120,
      filters: [
        {
          key: 'status',
          type: 'enum',
          label: 'Status',
          options: STATUS_OPTIONS.map((value) => ({ value, label: value })),
        },
      ],
    },
    {
      field: 'actor',
      headerName: 'Actor',
      minWidth: 160,
      flex: 1,
      filters: [{ key: 'performedById', type: 'string', label: 'Actor ID', placeholder: 'Employee UUID' }],
    },
  ]

  const { data, loading, error } = useQuery(AuditLogsDocument, {
    variables: toVariables(state),
    notifyOnNetworkStatusChange: true,
  })

  const rows = (data?.auditLogs.items ?? []).map(toRow)

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
        Audit log
      </Typography>

      {error !== undefined && (
        <Alert severity="error" sx={{ mb: 2 }} data-testid="screen-error">
          {error.message}
        </Alert>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        totalCount={data?.auditLogs.totalCount ?? 0}
        state={state}
        onStateChange={handleStateChange}
        loading={loading}
        searchable={false}
        emptyMessage="No audit entries match these filters"
        onRowClick={(row) => void navigate(`/bookings/${row.bookingId}`)}
      />
    </Box>
  )
}
