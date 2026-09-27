import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import { NavLink } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { isPermitted, NAV_ITEMS, type NavItem } from './nav-items'

function NavEntry({ item }: { item: NavItem }): React.ReactNode {
  const { permissions } = useAuth()
  if (!isPermitted(item, permissions)) {
    return null
  }
  return (
    <ListItem disablePadding data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}>
      <ListItemButton component={NavLink} to={item.path}>
        <ListItemText primary={item.label} />
      </ListItemButton>
    </ListItem>
  )
}

/**
 * Renders only the operations the session's permission set allows. This is a
 * usability affordance (NFR-5): the same permission is enforced again by the
 * server on every request behind these links.
 */
export function Nav(): React.ReactNode {
  return (
    <List data-testid="nav">
      {NAV_ITEMS.map((item) => (
        <NavEntry key={item.path} item={item} />
      ))}
    </List>
  )
}
