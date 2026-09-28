/**
 * Converting between the two date shapes in this app.
 *
 * The API's `DateTimeISO` is an instant at UTC in RFC 3339, so a create-booking
 * datetime typed as `2026-03-04T09:00` becomes an ISO string carrying whatever
 * offset the viewer's zone put it at — the *instant* the user meant, which is
 * the only thing the server can store.
 *
 * A date-range *filter* is the other direction: a calendar picks a day, and a
 * day is not an instant. `startDate` therefore means the first instant of that
 * day and `endDate` the last, so "from the 4th to the 4th" includes a booking
 * that starts at 16:00 on the 4th instead of excluding it. Doing that in one
 * place is what stops a filter from meaning something subtly different on two
 * screens.
 */

/** The viewer's local `YYYY-MM-DDTHH:mm` (a `datetime-local` value) → UTC ISO. */
export function localInputToIso(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`"${value}" is not a valid date-time`)
  }
  return parsed.toISOString()
}

/** `YYYY-MM-DD` → the first instant of that day, in the viewer's zone. */
export function startOfDayIso(day: string): string {
  return localInputToIso(`${day}T00:00:00`)
}

/** `YYYY-MM-DD` → the last instant of that day, in the viewer's zone. */
export function endOfDayIso(day: string): string {
  return localInputToIso(`${day}T23:59:59.999`)
}
