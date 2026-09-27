import { useState, type FormEvent, type ReactNode } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'

const SIGN_IN_FAILED = 'Sign-in failed. Check your email and password.'

export function LoginPage(): ReactNode {
  const { status, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const from = (location.state as { from?: string } | null)?.from ?? '/'

  if (status === 'authenticated') {
    return <Navigate to={from} replace />
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      // No token is stored until the server has issued one and the profile
      // request that follows succeeds, so a failed attempt leaves the app
      // exactly as anonymous as it was.
      await login(email, password)
      navigate(from, { replace: true })
    } catch {
      // The server's own message is deliberately not shown: it is an
      // implementation detail, and one fixed message tells an attacker no more
      // than "these credentials did not work".
      setError(SIGN_IN_FAILED)
      setPassword('')
    } finally {
      setSubmitting(false)
    }
  }

  const busy = submitting || status === 'loading'

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: 2,
      }}
    >
      <Paper sx={{ p: 4, width: '100%', maxWidth: 400 }} elevation={3}>
        <Typography variant="h1" component="h1" gutterBottom>
          Resource Booking
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Sign in with your work account.
        </Typography>
        <Box component="form" onSubmit={(event) => void onSubmit(event)} noValidate>
          <Stack spacing={2}>
            {error !== null && (
              <Alert severity="error" data-testid="login-error">
                {error}
              </Alert>
            )}
            <TextField
              id="email"
              name="email"
              type="email"
              label="Email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              fullWidth
              required
            />
            <TextField
              id="password"
              name="password"
              type="password"
              label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              fullWidth
              required
            />
            <Button type="submit" variant="contained" size="large" disabled={busy} data-testid="login-submit">
              {busy ? <CircularProgress size={22} color="inherit" /> : 'Sign in'}
            </Button>
          </Stack>
        </Box>
      </Paper>
    </Box>
  )
}
