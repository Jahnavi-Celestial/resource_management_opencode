// Type-only import: this is the module augmentation that teaches `createTheme`
// about the DataGrid's own `palette.DataGrid` slots, without pulling the grid's
// runtime into the bundle (it is only rendered from C1).
import type {} from '@mui/x-data-grid/themeAugmentation'
import { createTheme } from '@mui/material/styles'

/**
 * PLAN.md changelog "MUI adopted for client styling": corporate-blue palette,
 * light mode only — v1 ships no dark-mode toggle, and `palette.mode` is pinned
 * to 'light' so nothing in the app has to branch on it.
 *
 * The blue is deliberately *not* MUI's stock #1976d2: a themed surface has to be
 * distinguishable from the library default, both for review and so the C0
 * acceptance suite can prove the theme is applied rather than merely installed.
 */
export const CORPORATE_BLUE = '#0f4c81'
export const CORPORATE_BLUE_DARK = '#0a3760'
export const CORPORATE_BLUE_LIGHT = '#33699e'

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: CORPORATE_BLUE,
      light: CORPORATE_BLUE_LIGHT,
      dark: CORPORATE_BLUE_DARK,
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#5b7083',
    },
    background: {
      default: '#f4f6f9',
      paper: '#ffffff',
    },
    text: {
      primary: '#1b2733',
      secondary: '#54606d',
    },
    // @mui/x-data-grid v9 reads the grid's own surfaces from the theme palette
    // (there is no `components.MuiDataGrid` slot in this major — the grid
    // derives its own border, radius and typography from the same theme). The
    // grid is only rendered from C1; declaring its palette here keeps the theme
    // the single place it is configured.
    DataGrid: {
      bg: '#ffffff',
      headerBg: '#eef2f6',
      pinnedBg: '#f7f9fb',
    },
  },
  shape: {
    borderRadius: 8,
  },
  typography: {
    fontFamily:
      '"Inter", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
    h1: { fontSize: '1.75rem', fontWeight: 600 },
    h2: { fontSize: '1.375rem', fontWeight: 600 },
    h3: { fontSize: '1.125rem', fontWeight: 600 },
  },
  components: {
    MuiButton: {
      defaultProps: {
        // A booking system is not a marketing page: no shouty ALL-CAPS buttons.
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: CORPORATE_BLUE,
        },
      },
    },
  },
})

export default theme
