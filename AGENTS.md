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
Reminders (FR-74/75) are still S10's job to enqueue.
The client (C0+) is not started yet.

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
npm run test:booking-create # booking create + concurrency acceptance tests (12 scenarios)
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
- Booking create/cancel are **service-layer only** — there is no
  `createBooking`/`cancelBooking` GraphQL mutation in the emitted schema, and no
  milestone row requires one (S6's concurrency criteria drive the service). C0
  will need both mutations (with `booking:create`/`booking:cancel:*` gating)
  before a client can create or cancel anything.
- The gateway reuses the HTTP server: `createRealtimeGateway(server, dataSource)`
  takes over the `upgrade` event for `/ws` only, so one port serves both GraphQL
  and WebSockets. Bad handshakes are refused with a raw `401`/`404` response
  before the WebSocket is established, so a rejected client never sees `open`.
