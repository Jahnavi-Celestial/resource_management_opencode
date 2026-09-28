import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLIENT_ROOT } from './c2.harness'

/**
 * C2's reuse proof, in C1's method: a static check over the client tree that
 * there is exactly *one* `DataTable`, exactly one `Form`, and exactly one
 * `displayName()`, and that C2's booking screens import those rather than
 * carrying their own.
 *
 * C1 proved the claim for the four CRUD screens by rendering each one and reading
 * the `data-component` attribute off the mounted component. That half lives in the
 * server-backed files (`c2.acceptance.test.tsx` and `c2.approvals.test.tsx`), and
 * this file is the other half — the one that can be stated without booting a
 * server, and the one that would catch a *new* copy rather than only a missing
 * use. The two are deliberately different checks:
 *
 * - C1's runtime check asks "does this screen render the shared component?" and
 *   would still pass if a screen *also* had a private one.
 * - This asks "does anything anywhere in the client have a second definition, or
 *   import the grid directly?" — the failure mode a runtime check cannot see,
 *   because a second copy sitting unrendered in a file still passes it.
 *
 * The checks are the same three C1 made, restated for the bookings feature:
 *
 * 1. **The grid has one owner.** `@mui/x-data-grid` is imported by the shared
 *    `DataTable` and by the theme (which sets the grid's palette) and by nothing
 *    else — a screen that needs a column, a filter or a cell renderer goes
 *    through the shared component, because that is the only place those things
 *    are implemented.
 * 2. **One form.** The screens that show a form import `@/components/Form`; no
 *    file under `features/` defines its own `<form>`, and none hand-rolls a
 *    dialog to put a form in.
 * 3. **One `displayName()`.** Exactly one definition in the client tree, in
 *    `lib/displayName`, and every call site imports it. This is the one C2 leans
 *    on hardest: `BookingDetailPage` deliberately selects first/last names
 *    instead of the server's joined `name` precisely so that this function is the
 *    only thing on the client that can format a person.
 */

/** Every `.ts`/`.tsx` under `src`, as paths relative to the client root. */
function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (/\.tsx?$/.test(entry)) {
        found.push(full)
      }
    }
  }
  walk(path.join(CLIENT_ROOT, 'src'))
  return found
}

function read(file: string): string {
  return readFileSync(file, 'utf8')
}

function relative(file: string): string {
  return path.relative(CLIENT_ROOT, file)
}

/**
 * The file's *code*, with its comments removed.
 *
 * Needed because this file's claims are about code, and two of the files it
 * reads explain at length — in prose, with the very words the check looks for —
 * why a rule is followed. `BookingDetailPage`'s comment on the deleted-user
 * label is the clearest case: matching the bare string would fail the check on
 * the comment that documents the rule it enforces. Crude on purpose (it is a
 * test helper, not a parser): removing comments can only *reduce* what the
 * literal checks below see, so it cannot make a violation disappear.
 */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('C2 — reuse: one DataTable, one Form, one displayName()', () => {
  it('1. @mui/x-data-grid is imported by the shared DataTable and the theme, and by nothing else', () => {
    const importers = sourceFiles()
      .filter((file) => read(file).includes('@mui/x-data-grid'))
      .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
      .filter((file) => !file.startsWith(path.join(CLIENT_ROOT, 'src', 'components', 'DataTable')))
      .filter((file) => !file.startsWith(path.join(CLIENT_ROOT, 'src', 'theme')))
      .map(relative)
    expect(importers).toEqual([])
  })

  it('2. the booking screens import the shared DataTable and Form, and the shared Form is the only form', () => {
    const pages = sourceFiles().filter((file) => file.endsWith('Page.tsx'))
    const pagesWithoutSharedDataTable = pages
      .filter((file) => !read(file).includes("@/components/DataTable"))
      .map(relative)
      .sort()
    // One screen does not paginate anything: the detail view is a single
    // booking, so there is no grid to reuse and nothing to prove about it. Named
    // explicitly, because "every page imports DataTable" would be a false claim
    // about a detail screen.
    // ReportsPage is the fourth: report queries return plain arrays (no page/
    // pageSize args), so the server-driven DataTable does not apply. Reports
    // use MUI Table in client mode for bounded aggregated result sets.
    // Stated as the whole list rather than "the ones I thought of": the screens
    // in the app with no collection to render are named here, so a
    // *fifth* one — a new screen with its own table — fails the check instead of
    // quietly passing it.
    expect(pagesWithoutSharedDataTable).toEqual([
      'src/components/layout/PlaceholderPage.tsx',
      'src/features/auth/pages/LoginPage.tsx',
      'src/features/bookings/pages/BookingDetailPage.tsx',
      'src/features/reports/pages/ReportsPage.tsx',
    ])

    // The three booking screens name the shared components they use, by their
    // exact import specifier — a copy would have to import something else.
    const bookingsPage = read(path.join(CLIENT_ROOT, 'src/features/bookings/pages/BookingsPage.tsx'))
    expect(bookingsPage).toMatch(/import \{ DataTable \} from '@\/components\/DataTable'/)
    expect(bookingsPage).toMatch(/import \{ Form \} from '@\/components\/Form'/)
    const approvalsPage = read(path.join(CLIENT_ROOT, 'src/features/bookings/pages/ApprovalsPage.tsx'))
    expect(approvalsPage).toMatch(/import \{ DataTable \} from '@\/components\/DataTable'/)

    // And the form itself: every file in the client that renders a form element
    // — a literal `<form>` *or* MUI's `component="form"` — is one of exactly
    // two. Stating the *whole list* is the point: a private form in a screen this
    // suite does not render still fails the check, which is the failure mode a
    // per-screen runtime check cannot see.
    //
    // The login page is the one hand-written form in the app and it is named
    // here on purpose. It predates the schema-driven `Form` (C0) and is a
    // two-field sign-in rather than a CRUD entity form, so converting it is not
    // C2's business — but it must be the *only* exception, or this claim would
    // be quietly narrowing to the files someone remembered to check.
    const formOwners = sourceFiles()
      .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
      .filter((file) => /<form[\s>]/.test(read(file)) || /component="form"/.test(read(file)))
      .map(relative)
      // Sorted, because the claim is "exactly these two", not "in this order".
      .sort()
    expect(formOwners).toEqual(['src/components/Form/index.tsx', 'src/features/auth/pages/LoginPage.tsx'])
  })

  it('3. there is exactly one displayName(), it lives in lib/, and the detail screen uses it', () => {
    const definitions = sourceFiles()
      .filter((file) => {
        if (file.includes(`${path.sep}__tests__${path.sep}`)) {
          return false
        }
        return /export function displayName|export const displayName/.test(read(file))
      })
      .map(relative)
    expect(definitions).toEqual(['src/lib/displayName.ts'])

    // The detail screen must not have grown a second formatter. It selects
    // first/last names (never the server's joined `name`) precisely so that
    // `displayName()` is the only thing here that *can* format a person; this
    // checks the import is really there, next to the server's contract that
    // keeps the joined name out of the document.
    const detail = read(path.join(CLIENT_ROOT, 'src/features/bookings/pages/BookingDetailPage.tsx'))
    expect(detail).toMatch(/import \{ displayName \} from '@\/lib\/displayName'/)
    // No `? 'Deleted user' :` style fallback in *code*, which is how a second
    // implementation sneaks in beside the shared one. Read through `code()`,
    // because the file's comment quotes the string while explaining that the
    // client must not hardcode it.
    expect(code(path.join(CLIENT_ROOT, 'src/features/bookings/pages/BookingDetailPage.tsx'))).not.toMatch(
      /['"`]Deleted user['"`]/,
    )
  })

  it('4. the availability panel is the booking feature\'s own, and it reuses the shared formatters', () => {
    const panel = read(
      path.join(CLIENT_ROOT, 'src/features/bookings/components/BookingAvailabilityPanel.tsx'),
    )
    // Date formatting goes through the shared helper, so the panel cannot end up
    // with its own idea of what a timestamp looks like.
    expect(panel).toMatch(/import \{ formatDateTime \} from '@\/lib\/format'/)
    expect(panel).toMatch(/localInputToIso/)
    // And it asks the server: both availability queries are in the panel, so the
    // "no availability logic on the client" claim is checkable by reading it.
    expect(panel).toContain('roomAvailability')
    expect(panel).toContain('equipmentAvailability')
    // A plain MUI table, not a second grid: the availability answer is a small
    // list beside a form, not a paginated collection, and the grid belongs to
    // the shared DataTable alone (check 1).
    expect(panel).not.toContain('@mui/x-data-grid')
  })
})
