import { useState } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Badge from '@mui/material/Badge'
import Popover from '@mui/material/Popover'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Divider from '@mui/material/Divider'
import Skeleton from '@mui/material/Skeleton'
import Alert from '@mui/material/Alert'
import { useQuery, useMutation } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import {
  UnreadCountDocument,
  MyNotificationsDocument,
} from '@/features/notifications/graphql/notifications.graphql'
import {
  MarkNotificationReadDocument,
  MarkAllNotificationsReadDocument,
} from '@/features/notifications/graphql/notifications.mutations'

const PAGE_SIZE = 10

/** A 16×16 bell, inline — no icon package dependency. */
function BellIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" {...props}>
      <path d="M12 22c1.1 0 2-.9 2-2h-4a2 2 0 002 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
    </svg>
  )
}

/** A 12×12 check mark, inline. */
function CheckIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" {...props}>
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
    </svg>
  )
}

export function NotificationBell(): React.ReactElement {
  const { status } = useAuth()
  const navigate = useNavigate()
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)
  const open = anchorEl !== null

  const { data: countData } = useQuery(UnreadCountDocument, {
    fetchPolicy: 'cache-and-network',
    skip: status !== 'authenticated',
  })
  const unreadCount = countData?.unreadCount ?? 0

  const { data: listData, loading: listLoading, error: listError } = useQuery(
    MyNotificationsDocument,
    {
      variables: { page: 1, pageSize: PAGE_SIZE, sort: { field: 'createdAt', direction: 'DESC' as const } },
      fetchPolicy: 'cache-and-network',
      skip: status !== 'authenticated',
    },
  )

  const [markRead] = useMutation(MarkNotificationReadDocument)
  const [markAllRead] = useMutation(MarkAllNotificationsReadDocument, {
    refetchQueries: ['UnreadCount', 'MyNotifications'],
  })

  const notifications = listData?.myNotifications.items ?? []
  const loading = listLoading || (listData === undefined && !listError)

  const handleOpen = (event: React.MouseEvent<HTMLElement>) => setAnchorEl(event.currentTarget)
  const handleClose = () => setAnchorEl(null)

  const handleMarkAllRead = async () => {
    await markAllRead()
    setAnchorEl(null)
  }

  const handleNotificationClick = async (notification: { id: string; bookingId: string | null; isRead: boolean }) => {
    if (!notification.isRead) {
      try {
        await markRead({ variables: { id: notification.id } })
      } catch {
        /* best effort; the page re-fetches on visit */
      }
    }
    if (notification.bookingId) {
      navigate(`/bookings/${notification.bookingId}`)
    }
    setAnchorEl(null)
  }

  return (
    <>
      <IconButton
        color="inherit"
        onClick={handleOpen}
        disabled={status !== 'authenticated'}
        data-testid="notification-bell"
        aria-label="notifications"
      >
        <Badge
          badgeContent={unreadCount > 99 ? '99+' : unreadCount}
          color="error"
          invisible={unreadCount === 0}
          data-testid="notification-badge"
        >
          <BellIcon />
        </Badge>
      </IconButton>

      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 380, maxHeight: 420, overflow: 'auto' } } }}
        data-testid="notification-popover"
      >
        <Box sx={{ p: 1.5 }}>
          <Box sx={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <Typography variant="subtitle1">Notifications</Typography>
            {unreadCount > 0 && (
              <Button size="small" onClick={handleMarkAllRead} data-testid="mark-all-read">
                Mark all as read
              </Button>
            )}
          </Box>
        </Box>
        <Divider />

        {listError && (
          <Alert severity="error" sx={{ mx: 1.5, mb: 1 }} data-testid="notification-list-error">
            Failed to load notifications.
          </Alert>
        )}

        {loading && (
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} variant="text" width="80%" />
            ))}
          </Box>
        )}

        {!loading && !listError && notifications.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 3, textAlign: 'center' }} data-testid="notification-empty">
            No notifications yet.
          </Typography>
        )}

        {!loading && !listError && notifications.length > 0 && (
          <>
            <List disablePadding>
              {notifications.map((notification) => (
                <ListItem
                  key={notification.id}
                  disablePadding
                  data-testid={`notification-${notification.id}`}
                  sx={!notification.isRead ? { backgroundColor: 'action.hover' } : undefined}
                >
                  <ListItemButton
                    onClick={() => handleNotificationClick(notification)}
                    selected={!notification.isRead}
                  >
                    <ListItemText primary={notification.title} secondary={notification.message} />
                    {!notification.isRead && (
                      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'primary.main', flexShrink: 0, ml: 1 }} />
                    )}
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
            <Divider />
            <Box sx={{ p: 1 }}>
              <Button fullWidth onClick={() => { handleClose(); navigate('/notifications') }} data-testid="view-all-notifications">
                View all
              </Button>
            </Box>
          </>
        )}
      </Popover>
    </>
  )
}
