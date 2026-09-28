import { useState, useCallback } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { DataTable } from '@/components/DataTable'
import { type DataTableColumn } from '@/components/DataTable/types'
import { INITIAL_TABLE_STATE } from '@/components/DataTable/types'
import { MyNotificationsDocument } from '@/features/notifications/graphql/notifications.graphql'
import { MarkNotificationReadDocument } from '@/features/notifications/graphql/notifications.mutations'
import { useAuth } from '@/auth/AuthProvider'
import { type Notification } from '@/realtime/ws-client'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Alert from '@mui/material/Alert'
import LinearProgress from '@mui/material/LinearProgress'

const PAGE_SIZE = 20

/** A 16×16 check mark, inline — no icon package dependency. */
function CheckIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" {...props}>
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
    </svg>
  )
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * The full notification list at `/notifications`. Reuses `DataTable`
 * as-is (server pagination, search, sort) rather than forking it.
 * The server's `myNotifications` already provides everything the
 * list needs: title, message, time, read state.
 *
 * The per-row mark-read action is passed through `DataTable`'s
 * `actions` prop — the table owns the column, not the mutation.
 */
export function NotificationsPage(): React.ReactElement {
  const { status } = useAuth()
  const navigate = useNavigate()
  const [state, setState] = useState(INITIAL_TABLE_STATE)

  const { data, loading, error } = useQuery(
    MyNotificationsDocument,
    {
      variables: {
        page: state.page + 1,
        pageSize: PAGE_SIZE,
        sort: state.sort ?? { field: 'createdAt', direction: 'DESC' },
      },
      fetchPolicy: 'cache-and-network',
      skip: status !== 'authenticated',
    },
  )

  const [markRead] = useMutation(MarkNotificationReadDocument, {
    refetchQueries: ['MyNotifications'],
  })

  const handleStateChange = useCallback(
    (next: typeof state) => setState(next),
    [],
  )

  const columns: DataTableColumn<Notification>[] = [
    { field: 'title', headerName: 'Title', sortField: 'createdAt', flex: 1 },
    { field: 'message', headerName: 'Message', flex: 2 },
    { field: 'createdAt', headerName: 'Time', sortField: 'createdAt', width: 140 },
    { field: 'isRead', headerName: 'Read', width: 80, align: 'center' as const },
  ]

  const actions = (row: Notification) => (
    <IconButton size="small" onClick={() => void markRead({ variables: { id: row.id } })} data-testid={`mark-read-${row.id}`} aria-label={`mark ${row.title} as read`}>
      <CheckIcon />
    </IconButton>
  )

  const rows = data?.myNotifications.items ?? []
  const totalCount = data?.myNotifications.totalCount ?? 0

  return (
    <Stack spacing={2}>
      <Typography variant="h4" component="h2">Notifications</Typography>

      {status !== 'authenticated' && (
        <Alert severity="warning" data-testid="notification-auth-gate">
          Sign in to see notifications.
        </Alert>
      )}

      {loading && <LinearProgress data-testid="table-loading" />}

      {error && (
        <Alert severity="error" data-testid="notification-list-error">
          Failed to load notifications.
        </Alert>
      )}

      {!loading && !error && rows.length === 0 && (
        <Alert severity="info" data-testid="notification-empty">
          No notifications yet.
        </Alert>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        totalCount={totalCount}
        state={state}
        onStateChange={handleStateChange}
        loading={loading}
        getRowId={(row) => row.id}
        actions={actions}
        actionsHeader="Action"
        emptyMessage="No notifications yet."
      />
    </Stack>
  )
}
