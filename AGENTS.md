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
`FORBIDDEN`, and a real Employee create/read/update/delete round trip). C2
(booking screens), C3 (the `ws` client and notification UI) and the rest are next.

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
npm run dev:client      # Vite dev server for apps/client (5173; set VITE_GRAPHQL_URL, default
                        # http://localhost:4000/graphql)
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
