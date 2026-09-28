# AGENTS.md

## Project Status

S0 (scaffold), S1 (schema + first migration), and S2 (auth, RBAC, seeds) are
complete per docs/PLAN.md, and the S2 acceptance suite
(`npm run test:s2`) passes. The S3 pagination contract
(`src/common/pagination/`: PageArgs, SortInput + whitelist, Paginated<T>,
applyPagination helper) is in place — `npm run test:pagination` proves it.
NFR-6 field-error formatting (`common/errors/field-errors.ts`:
InputValidationError + class-validator → extensions.fieldErrors, composing
with the S2 code convention) is in place — `npm run test:validation` proves
it against the live schema. `common/db/transaction.ts`
(`runInTransaction` + `tx.afterCommit`, FR-90/NFR-3) is in place —
`npm run test:transaction` proves rollback/commit callback semantics.
Loaders (`src/loaders/`: employee, rolePermissions stubs, one fresh set per
request via `createGraphQLContext`) and schema emission
(`apps/server/schema.graphql`, rewritten on every boot) are in place —
`npm run test:loaders` proves per-request isolation and no cross-request
cache leakage. S4 (employee/room/equipment CRUD), S5 (audit), S6 (booking
create/cancel with concurrency), S7 (list/detail/availability reads, FR-10,
FR-23, FR-29) and S8 (manager pending queue + approve/reject with in-transaction
re-validation and the FR-56 self-decision refusal, FR-50–56) are all complete and
their acceptance suites pass. S9 is complete (FR-57–61, FR-90): the notification read/mark surface
(`modules/notification/`: types, inputs, repository with recipient-scoped
queries, service whose `create(manager, ...)` takes the caller's EntityManager,
resolver) is in place. `npm run test:s9` is the single S9 entry point: it runs
all three S9 suites in sequence via `scripts/acceptance-s9.ts` (the notification
CRUD + booking-event wiring suite, the realtime suite, the email outbox suite),
reports every verdict even when one fails, and exits non-zero if any did. Those
suites prove create/list/pagination, unreadCount, markRead, markAllRead,
cross-user refusal, the FR-75 unique index, the shares-the-caller's-transaction
rule, requester/manager notification wiring, live ws push, and FR-61 end to end.
S10 (elapsed-booking completion + reminder enqueue, FR-72/74/75) is next. Booking-event wiring is in place:
`BookingService` registers post-commit notification writes through
`tx.afterCommit` (FR-90) — the write runs in a new transaction, then
`NotificationService.emitCreated` pushes each row to the recipient's live
sockets with an updated unread count. The WebSocket gateway
(`src/realtime/`: `gateway.ts` plain `ws` server, `connection-registry.ts`
employeeId → set of sockets, `events.ts` payload types) authenticates the
handshake with the same `resolveAuthContext` the GraphQL context uses, takes
over the `upgrade` event for `/ws` on the shared HTTP port, and is wired in
`main.ts` via `attachRealtimeGateway` — `npm run test:realtime` proves
valid-JWT accept, refusal of missing/garbage/forged/system-account tokens, live
approval push, two-tabs fan-out, offline recipients still written to the DB, and
unregistering on disconnect. Email is in place: `src/email/` holds the
S1-scaffolded `email-outbox.entity.ts` (already registered in data-source.ts, so
`check-schema` validates it), `email.service.ts` (`enqueue`/`enqueueForEmployee`
render subject+HTML at enqueue time and take the caller's EntityManager —
PLAN's "row written in the same transaction" means the post-commit one),
`email.types.ts`, `dispatcher.ts` (claim with FOR UPDATE SKIP LOCKED + a lease,
send outside any lock, exponential backoff capped, dead-letter to FAILED at
`EMAIL_MAX_ATTEMPTS`) and `providers/` (noop + SendGrid over plain `fetch`).
`src/jobs/` holds `dispatch-outbound-emails.job.ts` and the node-cron
`scheduler.ts`, wired in main.ts. Booking approve/reject enqueue the email via
their own `afterCommit` registration (`BookingService.enqueueDecisionEmail`), so
FR-61 dispatch can never touch a booking transaction — a send failure only ever
costs a retry. `npm run test:email` proves provider selection, the post-commit
enqueue, dispatch via noop, retry-on-throw with the booking still APPROVED,
exhaustion into FAILED, no-resend idempotency and subject/HTML injection safety.
Reminders (FR-74/75) and the elapsed-booking completion (FR-72/73) are done: S10
is complete. `src/jobs/complete-elapsed-bookings.job.ts` transitions elapsed
APPROVED bookings to COMPLETED in one transaction per booking, re-checking status
and end time under `FOR UPDATE` and writing the audit row with the seeded system
employee as actor — it never touches availability, because `isRoomAvailable` and
the equipment cap are *derived* from status and time, so a completed booking frees
its room and equipment with no release step. `src/jobs/send-reminders.job.ts`
reminds the requester for bookings starting within
`REMINDER_LEAD_TIME_MINUTES` (statuses PENDING/APPROVED, SQL `NOT EXISTS`
pre-filter, `NotificationRepository.hasReminder` re-checked inside the write
transaction, FR-75's unique index as the race backstop), creating the
notification *and* the FR-61 outbox row in one transaction and pushing the
notification over the ws gateway post-commit. Both are plain callables first and
scheduled jobs second, which is what lets the acceptance suites drive them with
an injected clock instead of waiting on a timer. S11 (reports, FR-66–70) is
complete: `modules/report/` holds `report.repository.ts` (four aggregated
QueryBuilder reads), `report.service.ts` (range/status validation only, no
transaction — a report mutates nothing), `report.resolver.ts` (four queries,
every one `@Authorized('report:read')`, no mutation exists) and `report.inputs.ts`/
`report.types.ts`. `npm run test:reports` (alias `test:s11`) is the single entry
point. C0 (client foundation) is complete: `apps/client` holds the Vite + React +
TS scaffold, MUI v9 with a corporate-blue light-only theme
(`src/theme/index.ts`, `ThemeProvider` in `src/AppProviders.tsx`), graphql-code-generator
(client-preset) against `apps/server/schema.graphql` with generated output in
the gitignored `src/graphql/`, an Apollo Client with `HttpLink` + a bearer auth link
and no ws link, a MUI login page, `AuthProvider` (login mutation → store JWT → `me` on
load), `usePermission`/`useAnyPermission`, and `RequirePermission` guards driven by the
one `NAV_ITEMS` list. C1 is complete: `src/components/DataTable/` (a generic,
entity-free `DataGrid` wrapper — server pagination/search/sort/filter, dynamic
columns, controlled `TableState`), `src/components/Form/` (field-schema driven,
dialog and inline, inline server field errors), `src/components/ConfirmDialog/`,
`src/lib/{displayName,fieldErrors,format,useDebouncedValue}.ts`, and four real
CRUD screens (`features/{employees,roles,rooms,equipment}`) wired into
`AppRoutes`/`NAV_ITEMS` with `usePermission` gating. `npm run test:c1` is the
single entry point: it boots the real server on an ephemeral port, records every
GraphQL request through a `fetch` wrapper, and proves the six C1 claims
(four-screen reuse, server-side page/sort/search/filter variables, the NFR-6
inline field error, `displayName()`, permission hiding plus the server's own
`FORBIDDEN`, and a real Employee create/read/update/delete round trip). C2's
first half is complete: `features/bookings/` holds the four generated documents
(`features/bookings/graphql/bookings.graphql.ts`: list, create, bookable rooms,
bookable equipment) and `pages/BookingsPage.tsx` (create dialog + server-driven
list). C2's second half is complete too: `pages/BookingDetailPage.tsx` is the
real FR-45–49 detail read — the requested dates, the server-derived processed
date/time and who decided it, the full status history, the requester with their
recent bookings, the room with its other overlapping bookings, and each
equipment line with its remaining availability for that window — with the
server's own refusal rendered as a single clean alert.
`/bookings/:id` is wired and guarded by the `/bookings` nav item, so a row click
lands on it, and the detail page's own back link and its embedded summaries mean
the click is now a shortcut over a real link rather than the only way in.
`npm run test:c2` is the single entry point: it boots the real server and drives
both screens in jsdom, proving ten claims across two files
(`c2.acceptance.test.tsx` + `c2.detail.test.tsx`). The list
half: a successful create shows the booking's UUID and the server's `PENDING`
status (FR-38); a refused create renders the server's own `CONFLICT` text with
the dialog still open, and the client-side rules (end after start, start not in
the past, at least one attendee) never reach the wire; the list and the create
form are the *same* `DataTable`/`Form` C1 proved reused; a `booking:read:own`
session's list is exactly the server's scoped page, id for id; and search plus
every filter reach the server as GraphQL variables. The detail half: a decided
booking shows its processed block (the approval case and, separately, the
rejection case with its reason) and a pending one shows none; the history lists
every transition oldest-first with its actor and timestamp; a deleted requester
*and* a deleted actor both read "Deleted user" **through `displayName()` itself**;
the room and equipment sections carry the hand-computed overlap and remaining
quantities (a projector 5 − 2 = 3, a camera 4 − 1 − 2 = 1); and a signed-in
employee who may not read the booking gets the server's `FORBIDDEN` text in the
error alert with no partial data — while the booking's own requester, in a second
session in the same run, still sees it. C2 is complete: the third half is the
manager's approval queue (`pages/ApprovalsPage.tsx`, FR-50–56) and the fourth is
the availability the booking form shows while it is being filled
(`features/bookings/components/BookingAvailabilityPanel.tsx`, FR-23 room / FR-29
equipment) plus the whole lifecycle through the app. Every booking screen is in
`REAL_SCREENS` in `AppRoutes.tsx` and guarded from the same `NAV_ITEMS` list, so
no booking route is a placeholder any more; `/audit` and `/reports` still are, and
they belong to C4 (docs/PLAN.md:270), not here. `npm run test:c2` is now five
files / 24 tests: the list+create and detail files, the approval queue, the
availability + lifecycle file (`c2.availability.test.tsx`), and the static reuse
proof (`c2.reuse.test.ts`, no server). C3 (the `ws` client and
notification UI) is built: `realtime/ws-client.ts` (JWT-authenticated
WebSocket over `?token=` query param, exponential-backoff reconnect,
`exp` expiry check), `realtime/useNotificationSocket.ts` (one socket
per session, Apollo cache write of `unreadCount` from server,
`NotificationSnackbar` toast), `components/layout/NotificationBell.tsx`
(bell + popover), `features/notifications/pages/NotificationsPage.tsx`
(DataTable, server pagination), `/notifications` route and nav item.
C4 is complete: `features/audit/` (read-only audit log screen at `/audit`,
gated by `audit:read`, DataTable with server pagination, filters in URL
query string, actor rendered through shared `displayName()`) and
`features/reports/` (four report screens at `/reports`, gated by
`report:read`, MUI Tabs, MUI Table in client mode for bounded aggregated
result sets — report queries return plain arrays with no page/pageSize
args, so server-driven DataTable does not apply). `npm run test:c0`/`c1`/`c2` pass.
`npm run test:c0`/`c1`/`c2` pass.

## Commands

npm run typecheck      # tsc --noEmit across all workspaces
npm run create-db      # ensure the local database exists
npm run migrate        # apply pending TypeORM migrations
npm run migrate:revert # revert the last applied migration
npm run check-schema   # verify entity metadata matches the live schema (no drift)
npm run seed           # idempotent seeds: FR-89 permissions, Admin/Manager/Employee
                       # roles, system account, bootstrap admin (ADMIN_EMAIL/ADMIN_PASSWORD)
npm run test:s2        # S2 acceptance suite: login/me, system-login refusal, generic
                       # authz errors, live permission revocation, lockout guard, no password field
npm run test:pagination # pagination contract: pageSize clamps to 100, non-whitelisted
                       # sort fields throw DomainError (offline, no DB needed)
npm run test:validation # NFR-6: invalid input → extensions.fieldErrors + BAD_USER_INPUT,
                       # no value echo/leak; S2 FORBIDDEN/UNAUTHENTICATED shapes unchanged
                       # (boots the app — needs local Postgres)
npm run test:transaction # runInTransaction/afterCommit: callback fires once on commit,
                        # zero times on rollback, writes durable/rolled back correctly
                        # (writes real rows — needs local Postgres)
npm run test:loaders   # NFR-1: concurrent requests get separate DataLoader
                        # instances, no cross-request cache leakage, rolePermissions
                        # batches two roles in one query; schema.graphql emitted on
                        # boot and non-empty (boots the app — needs local Postgres)
npm run test:booking-list # booking list acceptance tests
npm run test:booking-detail # booking detail acceptance tests
npm run test:booking-create # booking create + concurrency (service) and the two write
                              # mutations over GraphQL: createBooking gating + FR-38 UUID,
                              # cancelBooking own/any routing, refusal cases
npm run test:booking-availability # S7 availability views (FR-23/29) + employee history (FR-10)
npm run test:s7                # S7 full acceptance suite: NFR-1 N+1 elimination, NFR-4 100k performance, list/detail/availability
npm run test:s8                # S8 acceptance suite: one file, service-level FR-50–56 then the GraphQL layer
                               # (booking:approve/booking:reject gating, forced createdAt ASC sort, FR-56)
npm run test:s9                # ALL of S9 in one command: runs the three S9 suites in sequence via
                               # scripts/acceptance-s9.ts — notification CRUD + booking-event wiring
                               # (FR-57–60, FR-75 unique index, create() sharing the caller's
                               # transaction), realtime ws delivery, and the FR-61 email outbox. Reports
                               # all three verdicts even if one fails; exits non-zero if any failed.
                               # Each suite boots its own DataSource (and its own server on an ephemeral
                               # port where it needs one) — needs local Postgres, no dev server
npm run test:realtime        # WebSocket gateway (also run by test:s9; kept for focused iteration): valid-JWT accept, missing/garbage/forged/system-account
                              # refusal, live push on booking approval, two-tabs fan-out, offline
                              # recipient still written to the DB, disconnect unregisters
                              # (boots a real HTTP server on an ephemeral port — needs local Postgres)
npm run test:email     # FR-61 outbox (also run by test:s9; kept for focused iteration): provider selection, post-commit enqueue on approve/reject,
                      # noop dispatch -> SENT, provider throw -> attempts+backoff with the booking
                      # still APPROVED, exhaustion -> FAILED, no-resend idempotency, injection safety
                      # (owns the outbox through the dispatcher's injected clock, so a running
                      # dev server's cron cannot steal its rows — needs local Postgres)
npm run test:complete-elapsed-bookings  # FR-72 job alone (also run by test:s10): elapsed APPROVED -> COMPLETED with a
                                        # system-actor audit row, PENDING/future-end untouched, derived
                                        # availability flip, repeat runs a no-op (FR-75)
npm run test:send-reminders   # FR-74/75 job alone (also run by test:s10): lead-time window, PENDING/APPROVED only,
                             # FR-7 null-requester skip, one REMINDER + one outbox row per booking, repeat runs
                             # and two concurrent runs produce exactly one of each
npm run test:scheduler       # node-cron registration (also run by test:s10): all three jobs registrable with valid
                             # crons, both S10 jobs defaulting to BOOKING_JOBS_CRON, invalid cron/empty/duplicate
                             # name rejected at registration, a task really fires and stop() really halts it, a
                             # throwing run never becomes an unhandled rejection (no DB needed)
npm run test:s10       # ALL of S10 in one command: runs the three S10 suites in sequence via
                       # scripts/acceptance-s10.ts — complete-elapsed-bookings (FR-72/73/75), send-reminders
                       # (FR-74/75), and scheduler registration. Reports all three verdicts even if one fails;
                        # exits non-zero if any failed. The first two need local Postgres, no dev server
npm run test:reports     # S11 reports (alias test:s11): four report queries against a hand-computed fixture —
                         # room ranking (FR-66), per-employee per-status breakdown (FR-67), quantity-hours with
                         # range clipping (FR-68), per-month created/approved/rejected/cancelled (FR-69); the
                         # suite also captures the SQL TypeORM really sends, asserts GROUP BY + aggregate
                         # functions are in it, and runs EXPLAIN on that exact statement (FR-70); plus
                         # report:read gating, read-only-schema and range/status validation
                          # (needs local Postgres, no dev server)
npm run test:c0         # C0 client foundation: renders the real app (jsdom) against a real GraphQL server the
                        # suite boots on an ephemeral port — codegen output present and typed with no hand-written
                        # GraphQL, valid login stores the JWT and `me` populates the 19-key permission set, invalid
                        # credentials fail visibly with no token, nav/routes follow the permission set and a deep
                        # link to a gated route is refused, the MUI theme renders the corporate blue (and a
                        # different theme renders differently), and the Apollo client has no ws link
                        # (needs local Postgres, no dev server)
npm run test:c1         # C1 acceptance suite: boots the real server on an ephemeral port and drives the four
                        # CRUD screens in jsdom, recording every GraphQL request through a fetch wrapper —
                        # all four screens import the same DataTable/Form and nothing outside the shared
                        # component touches @mui/x-data-grid, page/sort/search and the room minCapacity/
                        # activeOnly filters reach the server as variables, a duplicate email renders inline
                        # under its own input with the dialog still open, displayName() matches the server's
                        # DELETED_USER_DISPLAY_NAME, a manager sees no write controls and the server still
                         # answers FORBIDDEN, and Employee create/edit/delete round-trips through the real API
                         # (needs local Postgres, no dev server)
npm run test:c2         # C2 acceptance suite: boots the real server on an ephemeral port and drives the
                        # booking list + create dialog *and* the booking detail screen in jsdom, recording
                        # every GraphQL request through a fetch wrapper. The list half: a successful create
                        # shows the booking UUID and the server's PENDING status, a refused create renders
                        # the server's own CONFLICT text with the dialog still open while the client-side
                        # rules (end after start, start not in the past, ≥1 attendee) never reach the wire,
                        # the list and the create form are the same shared DataTable/Form C1 proved reused, a
                        # booking:read:own session's list is exactly the server's scoped page id for id, and
                        # search plus every filter reach the server as GraphQL variables. The detail half
                        # (FR-45–49): the processed block for an approved *and* a rejected booking and none
                        # for a pending one, every transition oldest-first with actor + timestamp, a deleted
                        # requester and a deleted actor both rendered through displayName() itself, the
                        # hand-computed room/equipment overlap and remaining quantities, and a caller with no
                        # read permission getting the server's FORBIDDEN with no partial data while the
                        # requester still sees it. The approval half (FR-50-56): the queue
                        # lists only PENDING bookings in the order the server fixed and sorts
                        # nothing itself, approving shows the server's APPROVED answer and the
                        # decided request leaves the queue, a too-short reason is refused with the
                        # server's own message under the input, a valid reason is stored, NFR-5 both
                        # ways (a session holding only booking:approve is offered no Reject anywhere
                        # on the page while a direct rejectBooking from that same token is FORBIDDEN
                        # with the booking unchanged; a session with neither decision permission is
                        # refused the route *and* the direct call), and FR-56's self-decision comes
                        # back in the dialog the manager is looking at with nothing changed. The
                        # availability + lifecycle file (FR-23/29): the booking form's panel shows the
                        # server's own roomAvailability rows and equipmentAvailability numbers for the
                        # window typed so far, and the request that carried that window is asserted; a
                        # free window then has to show the server's *empty* answer, which is what stops
                        # the first half passing vacuously. The lifecycle test is one story across two
                        # sessions: create (UUID + server's PENDING) -> the row in the requester's own
                        # list -> a different person approves it from the walked queue -> the detail
                        # screen's status, its processed-by/at block and the PENDING->APPROVED
                        # transition, and the panel settles on one window rather than asking
                        # about every window the form passes through (the querying components are
                        # not mounted while the draft is moving). The reuse proof (no server): one
                        # owner of @mui/x-data-grid
                        # (the shared DataTable + the theme), one form (the shared Form + the login
                        # page, both named), and exactly one displayName() definition, which the
                        # detail screen imports and has no copy of.
                        # One file at a time (fileParallelism: false) - see the runtime note.
                        # Files: c2.acceptance, c2.detail, c2.approvals, c2.availability, c2.reuse
                        # (needs local Postgres, no dev server)
npm run dev:client      # Vite dev server for apps/client (5173; set VITE_GRAPHQL_URL, default
                         # http://localhost:4000/graphql, and VITE_WS_URL to the realtime
                         # gateway, default ws://localhost:4000/ws)
npm run codegen:client  # regenerate apps/client/src/graphql/ from apps/server/schema.graphql
                        # (run after any server schema change; the output is gitignored)
npm run dev            # boot server; GraphQL at http://localhost:3000/graphql,
                       # health check at http://localhost:3000/health,
                       # realtime at ws://localhost:3000/ws?token=<jwt>

Local PostgreSQL 18 (EDB install) at `/Library/PostgreSQL/18/bin`, port 5432 —
no Docker/CI per docs/requirements.md §5.4. DB credentials come from `.env`
(see `.env.example`).

## Runtime notes

Scripts outside `npm run dev`:
- Always run with: `npx tsx --tsconfig apps/server/tsconfig.json <file>`
- Plain `npx tsx` fails with TypeORM decorator errors (missing tsconfig)
- `config/data-source.ts` exports `createDataSource()` (a factory function), not a DataSource instance — call it, don't search exports for an instance
- dotenv config: import `'<path>/node_modules/dotenv/config.js'` if running a file outside the workspace, plain `'dotenv/config'` if inside it

## Architecture notes

- Migrations are handwritten and reversible in
  `apps/server/src/database/migrations/`; `synchronize` stays `false` (S0 rule).
- Shared enums live in `packages/shared/src` (booking-status, notification-type,
  permissions — the FR-89 catalogue, single source of truth for the seeds).
- Entities use explicit snake_case column names and `foreignKeyConstraintName`,
  matching the migration DDL 1:1 so `check-schema` reports no drift.
- GraphQL types are separate classes from TypeORM entities (`*.types.ts`), so
  `Employee.password` has no `@Field` anywhere and cannot be selected.
- Resolver framework is `type-graphql@2.0.0-rc.3`: every `@Field`/`@Arg` needs an
  explicit type function (tsx/esbuild emit no decorator metadata). HTTP layer is
  Apollo Server 4 (EOL Jan 2026 — AS5/express5 migration is a tracked follow-up,
  see docs/PLAN.md assumptions #6–#9).
- `btree_gist` is created/dropped by the first migration for the booking
  room+time-range exclusion constraint (FR-33 backstop).
- tsconfig is fully strict; entity properties use `!` because TypeORM populates
  them at runtime.
- `runInTransaction` has no nesting guard: any service callable from inside an
  existing transaction (S5 `AuditService`, S9 notification/email) must accept
  the caller's EntityManager and never open its own transaction — opening one
  internally is a bug, not a style choice (standing rule in docs/PLAN.md).
- `createGraphQLContext` (app.ts) builds one fresh `createLoaders(dataSource)`
  set per request (NFR-1); `createApp` rewrites `apps/server/schema.graphql`
  on every boot — that file is the C0 codegen input.
- `NotificationRepository` takes `recipientId` as a required first argument and  puts it in every `WHERE` clause (`list`, `countUnread`, `markRead`,
  `markAllRead`) — the caller's own id comes from `context.auth.employee.id` in
  the resolver, never from a client-supplied arg. `markRead` is a scoped
  `UPDATE ... WHERE id AND recipient_id AND is_read = false` followed by a
  recipient-scoped re-read, so a foreign id is never even loaded; the service
  then raises `NotFoundError('Notification not found')`, which discloses nothing
  about the other user's record (FR-3).
 - Realtime delivery is a post-commit side channel, never a source of truth: the
   `ws` gateway authenticates through `resolveAuthContext` (no token verification
   is reimplemented), and `NotificationService.emitCreated(manager, created)` runs
   only *after* the notification transaction has committed, so a rolled-back write
   is never pushed. `attachRealtimeGateway(null)` makes emits silent no-ops, so
   the database row is still written when nobody is connected.
 - Notification architecture (C3): `useNotificationSocket` owns exactly one
   `RealtimeSocket` per logged-in session, mounted once in `AppProviders` inside
   `AuthProvider`. The server's `unreadCount` is written verbatim to the Apollo
   cache (never incremented locally), and both `UnreadCount` and `MyNotifications`
   are refetched on every (re)open. The socket is gated by `realtime={true}` in
   `AppProviders`; the acceptance harnesses opt out because jsdom's `undici`
   `WebSocket` has a broken `dispatchEvent`. Notifications are available to every
   authenticated user — there is no notification permission key in FR-89.
- The outbox is *addressed*, not linked: `email_outbox` has no booking FK, only
  `to_email`, so acceptance suites that approve/reject must clear the rows
  addressed to their fixture employees (by address, before deleting the
  employees) or they leak into the shared dev database — where the dev server's
  cron will dutifully send them. A user-supplied `purpose` reaches a mail
  header, so `email.service.ts` `headerSafe()`s the subject (no CR/LF, capped)
  and HTML-escapes the body; the rendered row, not the template name, is what
  gets sent, so a template change never rewrites history.
- `main.ts` boots exactly the PLAN.md:87 sequence, awaiting each step before the
  next: DataSource → `createApp` (builds the schema and rewrites
  `apps/server/schema.graphql`, so anything that can reach `/graphql` can trust
  that file) → `listen` (awaits the `listening` event, so the log *and* the
  process state match the real order) → ws gateway → cron scheduler. The gateway
  therefore has its `upgrade` handler attached before the port can serve a
  request, and a second instance on a busy port reports
  `failed to start server: listen EADDRINUSE` instead of an unhandled `error`
  event.
- `createBooking`/`cancelBooking` are wired as GraphQL mutations (they were
  service-layer only until the S6 GraphQL layer landed). `createBooking(input:
  CreateBookingInput!)` is gated by `@Authorized('booking:create')` and delegates
  straight to `BookingService.createBooking`. `cancelBooking(id: ID!)` is a
  **single** mutation that routes on the caller's identity and permissions
  rather than exposing two: it reads `booking.employee_id` via
  `BookingService.requesterIdOf` and picks `cancelOwnBooking` (needs
  `booking:cancel:own`) when the caller is the requester, or `cancelAnyBooking`
  (needs `booking:cancel:any`) when they are not. Two consequences worth
  knowing: its `@Authorized()` carries **no** permission list, because
  `authChecker` requires *every* listed permission and which one applies is not
  known until after the lookup; and a caller who is the requester but holds only
  `booking:cancel:any` is refused rather than escalated through the any path
  (least privilege, and it matches FR-56's "no acting on your own booking"
  spirit — note the seeded Manager role has `:any` but not `:own`). The refusal
  happens *before* the lookup when the caller holds neither cancel permission,
  so a stranger cannot probe whether an id exists (FR-3).
- `booking.createBooking` and `booking.cancelBooking` are the two mutations the
  S6 GraphQL layer asserts, including the FR-37 asymmetry (the owner may cancel
  only while PENDING; the any-path also covers APPROVED) and the audit actor
  attribution for each path.
- The gateway reuses the HTTP server: `createRealtimeGateway(server, dataSource)`
  takes over the `upgrade` event for `/ws` only, so one port serves both GraphQL
  and WebSockets. Bad handshakes are refused with a raw `401`/`404` response
  before the WebSocket is established, so a rejected client never sees `open`.
- `createScheduler(jobs)` takes a generic `ScheduledJob { name, schedule, run }`,
  not job-specific types: each job factory carries its own cadence, so `main.ts`
  just composes the list and logs exactly what got registered. Two things about
  it are load-bearing, and `npm run test:scheduler` exists to keep them true:
  `cron.schedule(..., { scheduled: false })` — node-cron *starts* a task at
  `schedule()` time by default, so without that flag constructing a scheduler
  would itself be a side effect (a rejected registration would leave a live
  timer, and a scheduler only built by a test would keep the process alive
  forever); and a rejected `run()` is caught and logged, because a throwing job
  must not become an unhandled rejection or kill its own schedule. There is no
  `noOverlap` and no catch-up run on `start()` — both are safe only because
  every registered job is concurrency-*safe*, not just idempotent (`FOR UPDATE
  SKIP LOCKED` in the dispatcher, in-transaction re-checks plus a unique-index
  backstop in the two booking jobs), so an overlapping or post-restart run finds
  nothing due instead of duplicating work.
- The S7 100k perf fixture runs `ANALYZE booking` after its bulk seed, and that
  is load-bearing, not tidiness: without it `pg_statistic` still describes the
  near-empty table the previous run's cleanup left behind, the planner prices the
  tiny partial GiST exclusion index as a full scan at cost 0.25, and the EXPLAIN
  assertion sees `ex_booking_room_time_range` instead of
  `idx_booking_start_time_end_time`. The suite then fails on planner state it
  does not control, so never remove that statement.
- `BOOKING_JOBS_CRON` (default `*/5 * * * *`) drives both S10 jobs on one shared
  cadence — no interval is specified anywhere in the docs, so the choice and its
  reasoning live in `docs/PLAN.md` assumption #10. The email dispatcher keeps its
  own 1-minute `EMAIL_DISPATCH_CRON` because a queued mail is the one thing here
  a user is actively waiting on.
- Report semantics are fixed in the module rather than guessed per call, and
  `test:reports` exists to keep them true. A booking is in scope for a ranged
  report when its window **overlaps** the half-open `[from, to)` range
  (`start_time < to AND end_time > from`), and FR-68 **clips** each line's
  duration to the range with `LEAST`/`GREATEST` so a booking straddling a
  boundary contributes only its in-range hours — a 2h booking from 02-28 23:00
  to 03-01 01:00 is 1 quantity-hour, not 2. FR-68's default status filter is
  PENDING + APPROVED because that is what "committed" already means per FR-35
  (the same definition `availability.ts` enforces); a REJECTED/CANCELLED/
  COMPLETED booking commits nothing, so it is excluded unless the caller asks
  for it. FR-69 buckets "created" on `booking.created_at` and the three outcome
  counts on `audit_log.created_at`, because FR-40/FR-46 already define a
  booking's processed date as its audit entry's timestamp (there is no
  `processed_at` column, §6) — which means a booking created in one month and
  approved in the next shows up in both months' rows, and the two `UNION ALL`
  arms have to be merged on the month key (an outer `GROUP BY month` over
  `SUM()`, still inside one statement) so a month with creations but no
  decisions returns one row with zeros rather than two rows. `bookingsPerEmployee`
  groups on the nullable `booking.employee_id`, so a requester whose employee row
  was hard-deleted (FR-7) reports as one `employeeId: null` row labelled with the
  same `DELETED_USER_DISPLAY_NAME` constant the loaders use — in SQL, because
  fetching employees to format names in JS would be the aggregation-in-the-app
  that FR-70 forbids. Every report takes an optional `limit` clamped to
  `MAX_PAGE_SIZE` (NFR-2: no resolver returns an unbounded collection), and ranks
  are made deterministic by a name tie-break because booking counts tie often.
- `report.repository.ts` writes the FR-69 `UNION ALL` fragment without table
  aliases on purpose: a raw fragment inlined as a derived table has no metadata
  in the outer builder, so an `alias.column` reference inside it would be
    rewritten by property-name replacement. TypeORM only treats a `from(string,
    alias)` as a derived table when the string starts *and* ends with `(`/`)` —
    it quotes anything else as an identifier, which is a very confusing error.
- **No acceptance suite may assert a global count.** Every suite shares one
  development database, and the client suites *cannot* clean up after themselves —
  there is no `deleteBooking`, and an employee may be hard-deleted while its
  bookings stay behind (FR-7), so each `npm run test:c2` permanently adds a few
  PENDING bookings and a `booking` row with a null requester. A literal like
  `assert.equal(list.totalCount, 3)` therefore asserts that the database happens to
  be empty, and it passes until the first client suite runs. Three server suites
  assumed otherwise and were rescoped; the rule they now follow is the general one:
    - `booking-list` scopes every count to its own fixtures' window
      (`fixtureWindow`, January 2031 — the only bookings the suite places that far
      out) and replaced `totalCount === 3` for a status-text search with a
      *membership* claim, because `search` is a LIKE over purpose/room/requester/
      equipment *and* status, so any row whose purpose contains the word is a correct
      match. Never write "a search for X returns exactly N rows" for a term that is
      not unique to the fixtures.
    - **Membership is not scoping, and this bit too.** The same status-text search was
      rescoped to a membership claim *without* `fixtureWindow`, on the reasoning that
      "REJECTED" is a global value so the count is a fact about the database rather
      than about the query. That is true of the **count** and false of the **page**:
      `bookings` returns one page, ordered `start_time ASC`, so a membership
      assertion on an unscoped term asks whether this run's rejected booking is among
      the oldest N of every rejected booking any suite has ever made. It passed for
      weeks, then the shared table passed a hundred REJECTED rows and the suite
      failed on a fact about its own fixtures' age. The fix is `fixtureWindow` on
      that call like everywhere else — scope the *query*, keep the membership claim.
      So the rule generalises to: a global value makes a count unscopable, not a page
      unbounded.
    - `booking-approval` scenario 12b walks the whole `pendingQueue` page by page:
      the queue takes no `search` and no `status` argument, so it *is* the global
      PENDING set, its page 1 in a shared database is an earlier run's rows, and the
      suite's own fixtures — the newest — are not on it. `totalCount` is compared to
      `SELECT count(*) … WHERE status = 'PENDING'` rather than to a literal, which
      also proves the manager's queue is not filtered to their own bookings (FR-50).
    - `reports` gives both *global* aggregates an explicit range (the fixtures' nine
      bookings, January–March 2026) and `bookingsPerEmployee` an explicit
      `limit: 100`, since it is ranked by `totalCount DESC` and a shared database
      could otherwise push a small fixture requester off the end of the page. The
      FR-7 group's *shape* (`displayName` = "Deleted user", `email` = null) is
      asserted on the unranged call and its *count* on the ranged one.
  When a suite fails on a count, the fix is to scope the query, not to delete the
  rows and not to relax the assertion — and if the claim genuinely is "the whole
  table", compare it to a count the database computes.


- Client C0, in `apps/client`:
  - `codegen.ts` reads `../server/schema.graphql` — the same file the server
    rewrites on boot — and writes `src/graphql/` (gitignored). Run
    `npm run codegen:client` after any schema change, or the client's types are
    stale. `client-preset` v6 emits `TypedDocumentNode` documents plus result and
    variable types, *not* React hook wrappers: with Apollo Client 4 the generated
    document is the typed input to `useQuery`/`useMutation`, so
    `useQuery(MeDocument)` is fully typed and no operation is ever hand-written.
    The test suite fails if a `query`/`mutation` string appears anywhere outside
    `features/*/graphql/`.
  - `@/` is an alias for `src/` in all four of tsconfig, vite.config.ts,
    vitest.c0.config.ts and vitest.c1.config.ts; keep all four in step or the
    codegen output and the app resolve differently.
  - `AppProviders` (`ApolloProvider` → `ThemeProvider` → `CssBaseline` → router
    → `AuthProvider`) is the one provider stack, used by `main.tsx` *and* by the
    C0 suite, so the app under test is the app that ships. The router is
    `MemoryRouter` when `initialEntries` is passed and `BrowserRouter` otherwise.
  - The theme's corporate blue is `#0f4c81`, deliberately not MUI's stock
    `#1976d2`, and the C0 suite asserts the rendered button's
    `--variant-containedBg` is ours. Keep it that way: a themed surface has to be
    distinguishable from the library default for the test to mean anything.
    `@mui/x-data-grid` v9 has no `components.MuiDataGrid` slot — the grid reads
    `palette.DataGrid.{bg,headerBg,pinnedBg}` instead, which is what the theme
    sets, via the `themeAugmentation` type-only import.
  - There is no WebSocket link (FR-59: GraphQL is query/mutation only). The
    gateway client arrives in C3 as its own module under `src/realtime/`; the
    suite fails if one appears in the Apollo link chain.
  - Client-side permission checks are a usability affordance only (NFR-5): the
    server re-checks every operation. `keys={[]}` on `RequirePermission` is the
    "any signed-in user" guard, and `NAV_ITEMS` is the single source for both the
    drawer and the route table so a link and its guard cannot drift.
  - `AuthProvider` mirrors the token into state (that is what re-triggers `me`),
    calls `client.clearStore()` *before* adopting a new identity so one render
    cannot show the previous user's cached `me`, and drops a token the server
    rejects rather than retrying it.
  - Client C1, the shared table and form. `DataTable` is *server*-driven (NFR-7):
    the grid is told `rows`/`rowCount`, and search/sort/filter/page are translated
    into GraphQL variables by the screen, never applied locally. Three things in
    it are load-bearing, and each one is a bug the C1 suite caught, so do not
    "simplify" them away:
    - The search draft is adopted from the parent only when the *incoming*
      `state.search` identity changes (`agreedSearch`), never when a keystroke is
      still inside the debounce. Comparing a draft against `state.search`
      directly looks like an external reset and discards the first character typed
      into an empty search box.
    - The debounced filter loop skips boolean filters. A boolean filter is applied
      on toggle, so it has no draft; reconciling it against its (always empty)
      draft deletes the value the user just set the moment any *other* filter is
      typed — a silent, order-dependent loss.
    - A testid on an interactive control belongs on the `<input>`
      (`slotProps={{ htmlInput: { 'data-testid': … } }}`), not on the `TextField`
      root, or `user.clear()`/`user.type()` in a suite act on a `<div>`. A
      boolean filter carries no testid at all: it is reached by its accessible
      name, which is what a screen reader uses too.
    - `rowCount` is the last total the query told us, *not* whatever the current
      variables produced. A fourth thing, found by the C2 approval suite, and the
      only one here that is a real app bug rather than a test problem: the DataGrid
      clamps the current page into `0 .. ceil(rowCount / pageSize) - 1` whenever
      `rowCount` changes, and Apollo drops `data` for the duration of a cache miss,
      so a screen paging to a new page handed the grid `0`, the grid decided there
      was one page, and it silently yanked the user back to page 1 — the page they
      asked for never rendered, and no error was ever shown. The ref is seeded from
      the first render, so a screen with nothing loaded yet still reports 0. Do not
      "simplify" this back to `rowCount={totalCount}`: no suite paged past page 1
      before this, which is exactly why it survived C1 and C2's first two halves.
  - `Form` owns the submit rejection. A screen's `onSubmit` awaits a mutation that
    *rejects* when the server refuses the write, and the screen renders that
    refusal from the mutation's own error state (`parseServerError` → inline field
    error, or one form-level `Alert`). So `Form` awaits `onSubmit` and swallows
    the rejection: the dialog must stay open with the typed values, and an
    unhandled rejection is not a UI state. The delete/retire handlers in the four
    screens do the same explicitly, because a confirm dialog has no form to render
    a field error in — they keep the dialog open and show `writeErrorMessage` in a
    `screen-write-error` banner instead.
  - `displayName()` returns the server's `DELETED_USER_DISPLAY_NAME`
    (`'Deleted user'`) for a null/blank name, and `first + last` otherwise; the C1
    suite reads the server loader's source to keep the two in step, because C2 and
    C4 both call this one function for a booking requester and an audit actor.
  - There is no `deleteRoom`/`deleteEquipment` in the API. "Delete" on those two
    screens is `update*(input: { isActive: false })`, behind the same confirm
    dialog, and the button says Retire so the UI does not promise an API that does
    not exist.
  - The C1 suite allowlists exactly two unhandled rejections in
    `c1.harness.tsx` — Apollo Client 4's `AbortError` on query teardown and its
    `CombinedGraphQLErrors` rethrow for a refused mutation — and asserts that
    *nothing else* escaped (`unexpectedRejections()`). Both entries are Apollo's
    own internal throw (`QueryManager.js` + rxjs frames, no `src/` frame); declaring
    `onError` on the hook was measured and changes neither, so no such stub is in
    the code. The allowlist was checked for being non-vacuous: an injected
    rejection fails the suite. Do not widen it.
  - Client C2 half 1, the booking list and create dialog. The shared components
    grew what these two screens needed, and three of those additions are reusable
    contracts rather than booking details:
    - `DataTable` filters are now `text` | `boolean` | `enum` | `date`. An `enum`
      filter has `options` and always renders an explicit `All` (an empty
      `{ field: null }` entry is how the screen says "no filter", so the control
      has to be able to *show* that state), a `date` filter is a day-bounded pair,
      and the bar's "Clear filters" clears the **bar only** — the search box is a
      separate control with its own state, so clearing the search is emptying the
      search box. That distinction is deliberate, and the C2 suite asserts both
      halves separately.
    - `onRowClick` hands the screen the row's `data-id`, and nothing else: the
      table *reports* a click, it does not route. Treat it as a pointer shortcut
      over whatever the row's first cell links to — C2's detail page is still a
      placeholder, so today the click is the only way in, and the real detail
      screen should carry a real link so the row click stays a shortcut.
    - `Form` gained `datetime` (converted by `src/lib/datetimes.ts`; the client
      sends ISO, the server owns all timezone semantics), a repeatable `group`
      field (keyed rows, per-row `itemFields`, add/remove, and composite field
      keys like `equipment.0.quantity` so an inline server field error lands under
      the right input of the right row), and `validateValues` — screen-supplied
      cross-field validation reported per field, through the same path as a server
      field error, so `parseServerError` and `validateValues` are one rendering
      path.
  - The client rules on the create form (end after start, start not in the past,
    at least one attendee) are format rules the client can decide on its own; no
    client code re-implements a *server* business rule such as the room
    double-booking, and no client string duplicates the server's message. The C2
    suite proves both halves of that: the three client rules never reach the wire,
    and the rendered refusal is the server's own `CONFLICT` text
    ("The selected room is not available for the requested time range"). The date
    filter is sent day-bounded from `startOfDayIso`/`endOfDayIso` because the
    server's own booking filter is `start_time >= startDate AND start_time <=
    endDate` — matching the server's semantics here is why the list date filter and
    the list the server returns can never disagree.
  - There is no `deleteBooking`, so every C2 run leaves its fixtures in the shared
    dev database forever, and page 1 of an unscoped list eventually fills up with
    older runs' rows. So every *grid* assertion in the C2 suite is scoped to a
    per-run `TOKEN` (`c2-<run>-…`, in the room, equipment and purpose names), and
    the only unscoped claims are about the request the screen sent — which is the
    part the client actually controls. Do not "fix" a failing row assertion by
    loosening it to page 1; scope it to the token or assert the request instead.
    Cleanup is limited to what the API allows: delete the fixture employees,
    retire the room and equipment. A C2 run never enqueues an outbox row (no
    booking is ever decided in half 1), so there is nothing to clear there.
  - The detail screen's name rule is a *server contract*, not a client choice, and it
    is the reason `BookingActor` and `BookingRequester` grew nullable
    `firstName`/`lastName` (`apps/server/src/modules/booking/booking.resolver.ts`
    `toBookingActor` + the `requester` resolver) instead of just the server's
    pre-joined `name`. `BookingDetailDocument` deliberately never selects `name`, so
    `displayName()` is the only thing on the client that *can* format a person — a
    second implementation would have nothing to read, which is how the C2 detail
    suite proves the function is used rather than merely produces the same string.
    The joined `name` stays for the list, where the server batches one row per booking
    (NFR-1) and joining per item would be the N+1 the loaders exist to prevent. A
    deleted requester's *email* is still the server's `DELETED_USER_DISPLAY_NAME`
    string: there is one server-side fallback for that column, and no client
    formatter.
  - `c2.detail.test.tsx` proves `displayName()` is used by *wrapping* it —
    `vi.mock` with `importOriginal`, delegating to the real function and recording the
    payload — not by replacing it, and then asserting the two label shapes (a record
    with no name parts, and one with them) both came out of that one call site. The
    proof was checked for being non-vacuous by swapping the requester's label in
    `BookingDetailPage` for a `id === null ? 'Deleted user' : name` cheat and re-running:
    tests 3 and 5 fail. Do not narrow that assertion to a call *count* — Apollo's
    `cache-and-network` renders the page more than once, so a count is an artefact of
    the render count, not of the claim.
  - Three jsdom facts the detail suite runs into, each one a silent-vacuity trap rather
    than an error, so all three are now in the test's own helper rather than in each
    test:
    - The token is persisted in `localStorage` (as it is in a browser), so a second
      `renderApp` in the same file starts out as the **previous** identity. The detail
      suite needs three different people in one run, and without an explicit sign-out
      the "employee who may not read this booking" *is* the admin and the refusal
      claim proves nothing. Sign out through the shell's own `sign-out` button.
    - `renderApp` leaves its container in `document.body` after `unmount()`, and two
      mounted apps put two `auth-probe` nodes in the document. The harness's `probe()`
      requires exactly one, so the error is "Found multiple elements" from somewhere
      that looks unrelated. One render at a time.
    - `processesAt` needs one pass over `data.booking` for its two lookups
      (`processedAt`/`processedBy` and `statusHistory`); reading only the first one and
      stopping leaves `data` non-null but the second lookup undefined, which is
      "cannot read property of null" three lines later rather than a failed assertion.
  - The two C2 lessons that cost the most iterations, both now asserted by
    `c2.harness.tsx`'s `settleTable()` and `lastRequest()`, and both true of any
    future client suite:
    - A *cleared* search/filter produces variables the server has already
      answered, so Apollo serves them from its cache and **no request goes out**.
      A suite can never wait for one; the observable is the rendered rows, or the
      *next* request.
    - A search or filter change only lands after the table's 300 ms debounce, so a
      suite that clears the search and immediately asserts the next request's
      variables reads a stale state and reports a phantom filter bug. Wait out the
      debounce before touching the next control.
  - MUI query shapes the C2 harness relies on, each found by probing rather than
    assumed: a `Select`'s accessible name resolves to the combobox `<div>` (click
    it to open, then pick by option text), a `datetime-local` field's label
    resolves to the real `<input>`, and `data-testid="field-*"` sits on the
    TextField wrapper `<div>` — so `setDateTime`/`selectOption` are label-based on
    purpose. Related: an open modal marks the page behind it `aria-hidden`, so a
    grid assertion made while the create dialog is open cannot see any rows. Close
    the dialog first, then look.
  - C0's route-guard test asserted `placeholder-bookings` because `/bookings` was a
    placeholder when C0 landed; C2 replaced it with the real screen, so that
    assertion now names the real screen's `datatable` root. The *claim* is
    unchanged (a permitted route opens, and it is not the denial page), and
    `/reports` is still a placeholder, so the guard is still exercised against a
    route with no screen of its own.
  - `onRowClick` hands the screen the row's `data-id` and nothing else: the table
    *reports* a click, it does not route. The detail screen therefore carries a real
    back link, and the requester's and the room's other bookings are real
    `/bookings/:id` links, so the row click is a shortcut over links rather than the
    only way into a booking. `c2.acceptance.test.tsx` still drives the click, because
    the claim being proved is that the clicked row's own id is what the route carries.
  - Client C2 half 3, the approval queue. Five things in it are contracts rather
    than approval details, and four of the five were found by the suite failing:
    - **The queue is a global PENDING set with no `search` argument and no sort
      argument**, so "find my row" is a *pagination* problem: the fixtures of a run
      are the newest bookings, every earlier client run's PENDING bookings are
      still there, and the DataGrid's footer has only previous/next — no "Go to
      last page". `showRow()` therefore takes the largest page size, reads the
      *current page* out of the footer's own `1–100 of 144` label, and steps
      forward until the row appears or the grid stops moving. The label is the
      observable, deliberately: the request is not (a page already fetched is
      answered from Apollo's cache and never reaches the wire) and the next
      *button* is not either — at the last page it still looks enabled, a click
      changes nothing, and a "no request" assertion there is a 5-second timeout
      rather than a failure. The walk is also why a row must be matched on its
      `data-id`: the booking UUID is not in a row's accessible name, so
      `getByRole('row', { name: /uuid/ })` is `null` whether the row is there or
      not.
    - **`pendingQueue` is ordered `createdAt ASC` and that is FR-50's "requested
      date/time"**: the order the requests were made, so the longest-waiting one is
      first. The resolver forces the sort and S8 scenario 12/12b pins it; the
      screen shows the requested *window* as columns and never re-sorts a page of a
      server-paginated set. Do not "fix" the screen into sorting by start time.
    - **A session that can reach the queue is not necessarily a session that can
      read it.** `BookingResolver.requester` calls `readScope` for a request's
      "other recent bookings" *even when the client selects only the name*, so a
      `booking:approve`-only session is refused on that field and the whole
      `pendingQueue` query fails with it. The suite's approver-only role is
      therefore approve + `booking:read:all`, and the reason is a comment there:
      an approver who cannot read bookings cannot see the queue at all.
    - **A refusal has to render where the user is looking.** FR-56's self-decision
      comes back *after* the confirm dialog is open, and an open MUI modal marks
      everything behind it `aria-hidden`, so a banner on the page is in the DOM and
      unreachable. `ConfirmDialog` grew an `error` prop for exactly this; the suite
      asserts the alert's text is the server's own message, which it reads off the
      wire for the same booking and the same session.
    - The suite's own fixtures are the reason its cleanup is not the other suites'
      cleanup: approving and rejecting is most of what it does, and the outbox is
      addressed rather than linked, so `c2.harness.tsx` grew `clearOutboxFor()`,
      one fixed `DELETE … WHERE to_email = ANY($1)` over its own `pg` connection,
      run *before* the employees are deleted (the address is the only handle). It
      asserts `>= 4` deleted rows so a cleanup that quietly matched nothing cannot
      pass. `envValue()` in the same file now strips one layer of quotes the way
      dotenv does — `DB_PASSWORD="…"` in `.env` authenticated as a password
      *including* the quote marks, against a server the same file had just booted.
    - The C2 allowlist for unhandled rejections is the C1 one, and it had the same
      latent hole: the same Apollo teardown arrives as an `Error` *or* as the
      `DOMException` jsdom's `AbortController` rejects with, and `DOMException` is
      not an `instanceof Error` there, so C1 failed roughly one run in three on a
      teardown it is meant to tolerate. The check now duck-types `name` +
      `message` instead. Re-measured for non-vacuity after the change: an injected
      `Error`, an injected string, and an object *named* `AbortError` with the
      wrong message all still fail the suite, while a DOMException carrying
      abort's own message is tolerated. It is still exactly two tolerated events.
    - `openQueueAs()` waits for the app to settle on *either* the grid or the
      guard's refusal, because which one you get is decided by the session rather
      than by the route — a helper that waited for the grid turned test 5's own
      claim (a session with no `booking:approve` is refused the route) into a
      timeout.
  - Client C2 half 4, the availability panel. It is a *view of the server's
    answer*, and the load-bearing decision is that it computes nothing: no
    overlap rule, no "this looks free", no subtraction of one booking from
    another. `roomAvailability` returns the overlapping bookings and an empty list
    is rendered as the server's empty answer, and `equipmentAvailability` returns
    the two numbers that are printed. A client rule would be a weaker second copy
    of FR-35's "committed" definition, evaluated against a snapshot another
    requester can invalidate before the create lands — and it would sit *beside*
    the server's own `CONFLICT` in the same dialog, so the user would be told two
    different things about the same slot. The one comparison the panel does make
    is about the *draft*, not the world (the server says N are left, the draft
    wants M → a "fewer than requested" chip), and it never blocks the submit.
    Three things about how it is wired:
    - **The panel reads the form's draft, it does not copy it.** `Form` grew one
      optional prop, `renderExtra: (values) => ReactNode`, rendered under the
      fields with the values as they stand. That is the same shape as
      `validateValues` (a screen-supplied function the form calls), and it is why
      the create dialog can show live availability without a second set of form
      state. It must return an *element*: the returned component owns its hooks,
      so it is a normal child, not a callback running another component's hooks
      inside the form's render.
    - **`optionalNumberValue()` exists for drafts.** `numberValue()` is the
      *submit* reader and throws on an empty field, which is right there (the form
      has already refused to submit) and wrong for a draft being watched: while the
      user types, the value is whatever the keystrokes have produced, and a blank
      or half-typed line is 0 rather than an exception. Do not "simplify" the
      panel by using `numberValue`.
    - **The window is debounced, and while it settles the panel answers nothing.**
      `AVAILABILITY_DEBOUNCE_MS` is 300 ms — the same pause `DataTable` puts on its
      search box — because `datetime-local` is a text field: typing "2026-03-04"
      produces a run of values that are each individually parseable, so without a
      pause a three-line draft costs a room query *and* three equipment queries per
      keystroke. Two things are load-bearing and both were got wrong first:
      the debounce is applied to the draft's *primitives*, not to the window object,
      because `useDebouncedValue` keys its timer on identity and a fresh object every
      render would restart its own timer forever; and while the debounce is pending
      the panel renders a progress bar and **nothing else** — the querying
      components are unmounted — because the alternative, keeping the last answer on
      screen, pairs one window's rows with another window's label, and the panel
      shows the *time* window, not the room, so a room change would leave the
      previous room's bookings under the new times. `pending` is therefore
      `questionKey(roomId, question) !== questionKey(settledRoomId, settled)`, with
      the room in the key even though it is not in `AvailabilityWindow`: a room
      change with the times untouched is a different question and must not read as
      settled.
    - **"Which request went out" is not an observable for this, and that is a
      property of the harness.** `c2.harness.tsx`'s recording fetch pushes to
      `recorded` *after* `await realFetch(...)` resolves, so a query the panel
      withdraws is cancelled and never recorded — which is exactly the request the
      debounce prevents. The claim is therefore asserted on the seam that actually
      governs it: `availability-pending` is present and `availability-room` is
      absent while the draft is moving, so the components that would issue those
      queries are demonstrably not in the tree. Asserting on the request log
      instead passes with `AVAILABILITY_DEBOUNCE_MS = 0` and proves nothing; it was
      measured, and it passed, which is why the test looks the way it does.
    - **Three refusal states, three different sentences.** `windowQuestion` returns
      `incomplete` / `unparseable` / `backwards` rather than one `null`, because
      "pick a room, a start and an end" is wrong advice once all three are filled in
      and the end is merely before the start. The end-not-after-start rule still
      belongs to the form's `validateValues`; this only decides when the *question*
      is worth asking.
    - **Per-room and per-item, permission-gated.** `room:read` and
      `equipment:read` gate the two queries separately, so each is `skip`ped for a
      session that lacks it (NFR-5 — the server would refuse it anyway; skipping
      is the courtesy, not the control). There is one query per equipment line
      because `equipmentAvailability` takes one item per call; that is the
      endpoint's shape, not an N+1 the screen chose, and there is no batched form
      of the query to call.
  - Client C2 half 5, the lifecycle and the reuse proof.
    - **FR-56 catches fixtures, not just users.** The availability suite's
      blocking booking could not be created *and* approved by the admin: the admin
      holds `booking:approve`, so the server refused its own approval with "A
      manager cannot approve or reject their own booking request". The fixture now
      has the requester create it and the admin approve it, which is also the
      arrangement FR-56 describes. A blocking fixture must also be APPROVED, not
      merely PENDING (FR-35), or the room is free and the availability assertions
      are measuring nothing.
    - **The page-walk helpers moved into `c2.harness.tsx`.** `showRow()`,
      `rowOnThisPage()`, `displayedPage()`, `settleGrid()`, `pageSizeValue()`,
      `PAGE_SIZE` and `signOutIfSignedIn()` were in `c2.approvals.test.tsx` and are
      now shared, because the lifecycle test walks the queue too and a second copy
      of a 100-line walk is exactly the duplication these suites exist to prevent.
    - **`c2.reuse.test.ts` is static and server-free, on purpose.** C1's method was
      a runtime check: mount the screen, read `data-component="DataTable"` off the
      mounted component. That half still exists for the bookings screens (test 3 of
      `c2.acceptance.test.tsx`), and it has a blind spot — a *second* copy of a
      component sitting unrendered in a file still passes it. So the static half
      states the whole list rather than the files someone remembered to check:
      the only `@mui/x-data-grid` importers are the shared `DataTable` and the
      theme; the only files rendering a form element (`<form>` *or* MUI's
      `component="form"`) are the shared `Form` and the login page, which is named
      as the one sanctioned exception (C0's two-field sign-in, predating the
      schema-driven `Form`); and there is exactly one `displayName()` definition,
      in `lib/displayName`. Non-vacuity was measured: adding a private
      `@mui/x-data-grid` import to `ApprovalsPage` fails check 1 by name.
    - **Two traps in the static checks, both found by them failing.** The detail
      screen's own comment quotes the string `Deleted user` while explaining why
      the client must not hardcode it, so the literal check reads the file through
      a `code()` helper that strips comments (a check that matched the comment
      would fail on the very thing that documents the rule). And MUI marks a
      required field's label with an asterisk, so `getByLabelText(/^room$/i)` does
      not match "Room *" — every label regex in these suites is anchored at the
      start only (`/^room/i`), which is also what `c2.acceptance.test.tsx` does.
  - `vitest.c2.config.ts` sets **`fileParallelism: false`**, and the reason is
    boot contention, not the timeout. The C2 files each spawn a real `tsx` server
    against *one* development database; three at once compiles the server and
    initialises TypeORM simultaneously, and roughly one run in five had a file's
    `beforeAll` miss the harness's health wait, which Vitest reports as that file
    being *skipped* — `11 passed | 5 skipped (16)` with no failing assertion, so
    it reads like a pass and is not one. Serialising the files removed most of it
    (1 failure in the 24 runs after the change, against ~2 in 34 before) but did
    not eliminate it, and the one failure that got through was never captured with
    its output, so the residual cause is still unknown. Two things make the next
    one diagnosable rather than another shrug: `waitForHealth` already appends the
    child server's entire stdout+stderr to its error, and the file-level verdict
    identifies the file (5 skipped = the two 5-test files, `c2.acceptance` or
    `c2.detail`). The health timeout is deliberately untouched at 90 s — the
    contention was the cause, and a longer budget would only hide it.
