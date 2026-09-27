import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Drawer from '@mui/material/Drawer'
import Stack from '@mui/material/Stack'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import { Outlet } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { Nav } from './Nav'

const DRAWER_WIDTH = 232

export function AppShell(): React.ReactNode {
  const { session, logout } = useAuth()
  const roles = session?.roles.map((role) => role.roleName) ?? []

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar position="fixed" sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}>
        <Toolbar sx={{ gap: 2 }}>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Resource Booking
          </Typography>
          {roles.map((role) => (
            <Chip key={role} label={role} size="small" data-testid={`role-${role}`} />
          ))}
          <Typography variant="body2" data-testid="current-user-email">
            {session?.employee.email ?? ''}
          </Typography>
          <Button color="inherit" onClick={() => void logout()} data-testid="sign-out">
            Sign out
          </Button>
        </Toolbar>
      </AppBar>
      <Drawer
        variant="permanent"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' },
        }}
      >
        <Toolbar />
        <Nav />
      </Drawer>
      <Box component="main" sx={{ flexGrow: 1, p: 3, width: `calc(100% - ${DRAWER_WIDTH}px)` }}>
        <Toolbar />
        <Stack spacing={2}>
          <Outlet />
        </Stack>
      </Box>
    </Box>
  )
}
