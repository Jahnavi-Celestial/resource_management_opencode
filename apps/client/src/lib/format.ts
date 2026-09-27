const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/** Server `DateTimeISO` → something readable. Anything unparseable renders ''. */
export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return ''
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '' : DATE_TIME.format(parsed)
}
