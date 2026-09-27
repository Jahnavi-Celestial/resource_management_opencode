import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import type { NavItem } from './nav-items'

/**
 * C0 ships the routing, the session and the permission wiring; the screens
 * themselves are C1+ (PLAN.md's client phases). This placeholder is
 * deliberately visible and self-identifying so a route that renders one is
 * obviously a route whose real screen has not been built yet.
 */
export function PlaceholderPage({ item }: { item: NavItem }): React.ReactNode {
  return (
    <Paper sx={{ p: 3 }} data-testid={`placeholder-${item.label.toLowerCase().replace(/\s+/g, '-')}`}>
      <Typography variant="h2" component="h1" gutterBottom>
        {item.label}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Placeholder — this screen is built in a later client phase. The route,
        its permission guard ({item.keys.join(' or ')}) and the session behind it
        are already real.
      </Typography>
    </Paper>
  )
}
