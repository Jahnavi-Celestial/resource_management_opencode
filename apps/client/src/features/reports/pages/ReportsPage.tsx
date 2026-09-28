import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import { endOfDayIso, startOfDayIso } from '@/lib/datetimes'
import {
  BookingsPerEmployeeDocument,
  EquipmentUsageDocument,
  MonthlyBookingStatisticsDocument,
  MostBookedRoomsDocument,
} from '../graphql/reports.graphql'
import type {
  BookingsPerEmployeeQuery,
  EquipmentUsageQuery,
  MonthlyBookingStatisticsQuery,
  MostBookedRoomsQuery,
} from '@/graphql/graphql'

function defaultRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000)
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

function formatMonth(month: string): string {
  const parsed = new Date(`${month}-01T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? month : parsed.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-GB').format(value)
}

interface DateRangePickerProps {
  from: string
  to: string
  onChange: (from: string, to: string) => void
}

function DateRangePicker({ from, to, onChange }: DateRangePickerProps): React.ReactElement {
  return (
    <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <TextField
        size="small"
        type="date"
        label="From"
        value={from}
        onChange={(e) => onChange(e.target.value, to)}
        slotProps={{ htmlInput: { 'data-testid': 'report-from' } }}
      />
      <TextField
        size="small"
        type="date"
        label="To"
        value={to}
        onChange={(e) => onChange(from, e.target.value)}
        slotProps={{ htmlInput: { 'data-testid': 'report-to' } }}
      />
    </Stack>
  )
}

function LoadingState(): React.ReactElement {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }} data-testid="report-loading">
      <CircularProgress size={28} />
    </Box>
  )
}

function EmptyState(): React.ReactElement {
  return (
    <Alert severity="info" sx={{ mt: 2 }} data-testid="report-empty">
      No data for this range.
    </Alert>
  )
}

function ErrorState({ message }: { message: string }): React.ReactElement {
  return (
    <Alert severity="error" sx={{ mt: 2 }} data-testid="report-error">
      {message}
    </Alert>
  )
}

function MostBookedRoomsTab({ from, to }: { from: string; to: string }): React.ReactElement {
  const { data, loading, error } = useQuery(MostBookedRoomsDocument, {
    variables: { range: { from: startOfDayIso(from), to: endOfDayIso(to) } },
  })
  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error.message} />
  const rows = data?.mostBookedRooms ?? []
  if (rows.length === 0) return <EmptyState />
  return (
    <Table size="small" data-testid="report-table-most-booked-rooms">
      <TableHead>
        <TableRow>
          <TableCell>Room</TableCell>
          <TableCell>Location</TableCell>
          <TableCell align="right">Capacity</TableCell>
          <TableCell align="right">Bookings</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row: MostBookedRoomsQuery['mostBookedRooms'][number]) => (
          <TableRow key={row.roomId}>
            <TableCell>{row.roomName}</TableCell>
            <TableCell>{row.location}</TableCell>
            <TableCell align="right">{formatNumber(row.capacity)}</TableCell>
            <TableCell align="right">{formatNumber(row.bookingCount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function BookingsPerEmployeeTab({ from, to }: { from: string; to: string }): React.ReactElement {
  const { data, loading, error } = useQuery(BookingsPerEmployeeDocument, {
    variables: { range: { from: startOfDayIso(from), to: endOfDayIso(to) } },
  })
  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error.message} />
  const rows = data?.bookingsPerEmployee ?? []
  if (rows.length === 0) return <EmptyState />
  return (
    <Table size="small" data-testid="report-table-bookings-per-employee">
      <TableHead>
        <TableRow>
          <TableCell>Employee</TableCell>
          <TableCell align="right">Pending</TableCell>
          <TableCell align="right">Approved</TableCell>
          <TableCell align="right">Rejected</TableCell>
          <TableCell align="right">Cancelled</TableCell>
          <TableCell align="right">Completed</TableCell>
          <TableCell align="right">Total</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row: BookingsPerEmployeeQuery['bookingsPerEmployee'][number]) => (
          <TableRow key={row.employeeId ?? 'deleted'}>
            <TableCell>{row.displayName}</TableCell>
            <TableCell align="right">{formatNumber(row.pendingCount)}</TableCell>
            <TableCell align="right">{formatNumber(row.approvedCount)}</TableCell>
            <TableCell align="right">{formatNumber(row.rejectedCount)}</TableCell>
            <TableCell align="right">{formatNumber(row.cancelledCount)}</TableCell>
            <TableCell align="right">{formatNumber(row.completedCount)}</TableCell>
            <TableCell align="right">{formatNumber(row.totalCount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function EquipmentUsageTab({ from, to }: { from: string; to: string }): React.ReactElement {
  const { data, loading, error } = useQuery(EquipmentUsageDocument, {
    variables: { range: { from: startOfDayIso(from), to: endOfDayIso(to) } },
  })
  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error.message} />
  const rows = data?.equipmentUsage ?? []
  if (rows.length === 0) return <EmptyState />
  return (
    <Table size="small" data-testid="report-table-equipment-usage">
      <TableHead>
        <TableRow>
          <TableCell>Equipment</TableCell>
          <TableCell align="right">Available</TableCell>
          <TableCell align="right">Bookings</TableCell>
          <TableCell align="right">Committed</TableCell>
          <TableCell align="right">Quantity-hours</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row: EquipmentUsageQuery['equipmentUsage'][number]) => (
          <TableRow key={row.equipmentId}>
            <TableCell>{row.equipmentName}</TableCell>
            <TableCell align="right">{formatNumber(row.quantityAvailable)}</TableCell>
            <TableCell align="right">{formatNumber(row.bookingCount)}</TableCell>
            <TableCell align="right">{formatNumber(row.totalQuantityCommitted)}</TableCell>
            <TableCell align="right">{formatNumber(row.totalQuantityHours)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function MonthlyStatisticsTab({ from, to }: { from: string; to: string }): React.ReactElement {
  const { data, loading, error } = useQuery(MonthlyBookingStatisticsDocument, {
    variables: { range: { from: startOfDayIso(from), to: endOfDayIso(to) } },
  })
  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error.message} />
  const rows = data?.monthlyBookingStatistics ?? []
  if (rows.length === 0) return <EmptyState />
  return (
    <Table size="small" data-testid="report-table-monthly-statistics">
      <TableHead>
        <TableRow>
          <TableCell>Month</TableCell>
          <TableCell align="right">Created</TableCell>
          <TableCell align="right">Approved</TableCell>
          <TableCell align="right">Rejected</TableCell>
          <TableCell align="right">Cancelled</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row: MonthlyBookingStatisticsQuery['monthlyBookingStatistics'][number]) => (
          <TableRow key={row.month}>
            <TableCell>{formatMonth(row.month)}</TableCell>
            <TableCell align="right">{formatNumber(row.created)}</TableCell>
            <TableCell align="right">{formatNumber(row.approved)}</TableCell>
            <TableCell align="right">{formatNumber(row.rejected)}</TableCell>
            <TableCell align="right">{formatNumber(row.cancelled)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

const TAB_LABELS = ['Most Booked Rooms', 'Bookings per Employee', 'Equipment Usage', 'Monthly Statistics'] as const

export function ReportsPage(): React.ReactElement {
  const [tab, setTab] = useState(0)
  const [range, setRange] = useState(defaultRange)

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
        Reports
      </Typography>

      <Paper sx={{ p: 3 }}>
        <Stack spacing={3}>
          <DateRangePicker from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />

          <Tabs value={tab} onChange={(_, v) => setTab(v)} data-testid="report-tabs">
            {TAB_LABELS.map((label) => (
              <Tab key={label} label={label} data-testid={`report-tab-${label.toLowerCase().replace(/\s+/g, '-')}`} />
            ))}
          </Tabs>

          {tab === 0 && <MostBookedRoomsTab from={range.from} to={range.to} />}
          {tab === 1 && <BookingsPerEmployeeTab from={range.from} to={range.to} />}
          {tab === 2 && <EquipmentUsageTab from={range.from} to={range.to} />}
          {tab === 3 && <MonthlyStatisticsTab from={range.from} to={range.to} />}
        </Stack>
      </Paper>
    </Box>
  )
}
