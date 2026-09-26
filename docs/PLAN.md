# Resource Booking Management System — Build Plan

Source of truth: `docs/requirements.md` (197 lines / 21,805 bytes as of this plan).
This document is the folder structure and build order derived from it. No code has
been written yet — this is the plan only.

Environment verified at planning time: Node v22.23.2, npm 10.9.8, local PostgreSQL 18.4
(EDB install) at `/Library/PostgreSQL/18/bin`, server already running on port 5432,
`btree_gist` extension available. No Docker/CI per §5.4 — local-dev only.

**Changelog vs. the previous version of this plan:** `docs/requirements.md` §6 was
updated to state that `AuditLog.performedBy` is nullable at the schema level (to
support `ON DELETE SET NULL`), that the application always inserts a real value, and
that the UI falls back to "Deleted user" for a deleted historical actor — the same
fallback already specified for booking requesters (FR-48). This removes what was
previously "Assumption #1" in this plan (a contradiction between FR-7's `SET NULL`
behavior and §6's old "non-nullable" wording); it is no longer an assumption, it is
now the spec. A full line-by-line re-read of the rest of the document found no other
changes. The consequence — audit-actor display needs the same fallback helper as
booking-requester display — is now reflected in phases S5/S7 and the client `lib/`
module below.

**Changelog (room now required):** `docs/requirements.md` FR-31 was updated — every
booking now requires a meeting room; equipment items remain optional (zero or more
per booking). This reverses the old "room optional if equipment selected" wording.
FR-34's room-capacity check is therefore unconditional, and FR-35 explicitly applies
only when equipment items are included. §6 no longer marks `Booking.roomId` as
nullable. Consequences for the S1 schema: `booking.room_id` is NOT NULL, and the
room+time-range exclusion constraint keeps only its status filter
(`status IN ('PENDING','APPROVED')`, per FR-33/FR-73) since the
`room_id IS NOT NULL` conjunct is redundant once the column is NOT NULL.

---

## Assumptions locked in

These resolve remaining ambiguities in the requirements doc. Flag any of these if
they're wrong; otherwise the plan below proceeds on this basis.

| #   | Ambiguity in doc                                                                                                                                            | Decision taken                                                                                                                                                                                                                                                                   | Reasoning                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Notification.recipientId` delete behavior unspecified (FR-7 only names Booking/AuditLog)                                                                   | `ON DELETE CASCADE`                                                                                                                                                                                                                                                              | A deleted employee's notifications are meaningless; no requirement needs them to survive                                                                                                                                                                                                                                      |
| 2   | Which statuses `booking:cancel:any` can target                                                                                                              | PENDING and APPROVED                                                                                                                                                                                                                                                             | FR-57 ("cancelled by another party") and FR-73 (cancellation removed from availability) both imply managers can cancel an already-approved booking, not just pending                                                                                                                                                          |
| 3   | `EmailOutbox` isn't in §6's entity list but FR-61/FR-90 require durable "logged and retried"                                                                | Add it as **infrastructure**, not a domain entity                                                                                                                                                                                                                                | In-memory retry doesn't survive a process restart; a table is the only way to guarantee retry after a crash                                                                                                                                                                                                                   |
| 4   | Sorting on `processedAt`/`processedBy` (derived from AuditLog, FR-40)                                                                                       | Not sortable in v1; filter/search stay on stored columns only                                                                                                                                                                                                                    | No FR asks for it; sorting a derived-per-row subquery breaks the flat index-driven pagination NFR-4 needs                                                                                                                                                                                                                     |
| 5   | Whether `Booking.numberOfAttendees` is optional — §6 lists the field but FR-31's original attribute list didn't state its required/optional status outright | Required on every booking (`NOT NULL` + `CHECK (number_of_attendees > 0)`)                                                                                                                                                                                                       | requirements.md FR-31 (clarified) states the attendee count is unconditionally required; a booking for zero people is not meaningful                                                                                                                                                                                          |
| 6   | PLAN assumed `type-graphql@1.2.0` as the stable resolver framework                                                                                          | Pin `type-graphql@2.0.0-rc.3` (npm `latest` dist-tag) in `apps/server/package.json`                                                                                                                                                                                              | `1.2.0` was never published stable (only `1.2.0-rc.1` exists); `2.0.0-rc.3` is the maintainer's current release. It requires explicit type functions on every `@Field`/`@Arg`, which is mandatory under tsx/esbuild anyway (no `emitDecoratorMetadata`) — this affects every resolver written from S2 onward                  |
| 7   | §5.1 stack table doesn't pin an Apollo Server major version                                                                                                 | Stay on Apollo Server 4 per the original scaffold; schedule an AS5 + express 5 migration as a follow-up once the app is functionally complete                                                                                                                                    | Apollo Server 4 is EOL (Jan 2026) with 2 moderate advisories in its bundled `uuid` (XS-Search prevention bypass; uuid buffer bounds check — neither on our usage path). The bump touches the whole HTTP scaffold, so it's a tracked follow-up, not a blocker for any phase                                                    |
| 8   | Bootstrap-admin credentials (email + initial password) are not specified anywhere in requirements.md                                                        | `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars (documented in `.env.example`, with local-dev defaults in code); `admin.seed.ts` creates the admin if missing and syncs its password to `ADMIN_PASSWORD` on every run; unset `ADMIN_PASSWORD` is a hard error when `NODE_ENV=production` | FR-5's "administrators create employees" needs one admin to pre-exist on a fresh DB; env-configured + synced keeps the bootstrap account seed-owned and deterministic while letting real deployments choose their own credentials                                                                                             |
| 9   | FR-72 suggests the reserved system account be `system@internal` ("e.g."), which is not a syntactically valid email                                          | Seed `system@internal.local` instead (`SYSTEM_EMPLOYEE_EMAIL` in `modules/employee/system-account.ts`)                                                                                                                                                                           | The `.local` TLD is reserved (RFC 6762, never routable), so collision risk is nil, and login input validation can stay strict (`@IsEmail`) — the service-layer refusal of the system account then fires with the same uniform `UNAUTHENTICATED` response as unknown-email, instead of being short-circuited by a format error |
| 10  | No cadence is specified anywhere for the FR-72/FR-74 jobs — §3.13 says only "a scheduled job", and §7 configures `REMINDER_LEAD_TIME_MINUTES` but no interval                                                            | One shared `BOOKING_JOBS_CRON` (default `*/5 * * * *`) drives both `complete-elapsed-bookings` and `send-reminders`, env-configurable exactly like S9's `EMAIL_DISPATCH_CRON`; the email dispatcher keeps its own 1-minute cron                                                             | The interval is purely a freshness/latency budget, because FR-75 makes both jobs idempotent and concurrency-safe, so running them more often costs only an index lookup. 5 minutes bounds reminder staleness at 5/60th of the 60-minute default lead time, and bounds how long a finished booking stays visibly APPROVED. One variable rather than two: both jobs read the same booking clock, and a deployment that wants a different cadence changes one line. Not tighter (1 minute) because the extra ticks buy nothing measurable, not looser (15+) because a 15-minute reminder lag against a 60-minute lead time starts to matter for a user who books 20 minutes ahead |

### Standing rule — inner services never open their own transaction

`runInTransaction` does not detect or guard against nesting. Any service
method that may be called from within an existing transaction
(`AuditService`, and later `NotificationService`/`EmailService` in S9) must
accept the caller's `EntityManager` as a parameter rather than calling
`runInTransaction` internally. This applies to every phase from S5 onward —
a service method that opens its own transaction internally instead of
accepting one is a bug, not a style choice.

---

## 1. Folder / module structure

```
resource_management/
├── AGENTS.md
├── README.md                          # local run instructions (no Docker, per §5.4)
├── package.json                       # npm workspaces: apps/*, packages/*
├── tsconfig.base.json
├── .env.example                       # REJECTION_REASON_MIN_LENGTH, REMINDER_LEAD_TIME_MINUTES, JWT_EXPIRY, ...
├── docs/                              # requirements.md, PLAN.md — spec source of truth, read-only
├── packages/
│   └── shared/                        # single source of truth, imported by both apps
│       └── src/
│           ├── permissions.ts         # PERMISSION_KEYS (FR-89) + PermissionKey union type
│           ├── booking-status.ts      # PENDING|APPROVED|REJECTED|CANCELLED|COMPLETED
│           └── notification-type.ts   # e.g. BOOKING_PENDING|APPROVED|REJECTED|CANCELLED|REMINDER
└── apps/
    ├── server/
    │   ├── .env.example
    │   ├── jest.config.ts
    │   ├── scripts/
    │   │   └── create-db.ts           # createdb + run migrations against local Postgres 18
    │   └── src/
    │       ├── main.ts                # boots DataSource → schema → http server → ws gateway → cron
    │       ├── app.ts                 # express + Apollo Server 4 wiring, emits schema.graphql
    │       ├── config/
    │       │   ├── env.ts             # typed/validated env
    │       │   └── data-source.ts     # TypeORM DataSource, synchronize:false, migrations glob
    │       ├── common/
    │       │   ├── errors/            # DomainError, ForbiddenError, formatError → fieldErrors (NFR-6)
    │       │   ├── pagination/        # PageArgs, SortInput, Paginated<T> (NFR-2)
    │       │   ├── graphql/           # GraphQLContext type, DateTime scalar
    │       │   ├── db/
    │       │   │   └── transaction.ts # runInTransaction(mgr => ...) with tx.afterCommit(fn) — FR-90/NFR-3; no nesting guard (standing rule above)
    │       │   └── logging/           # pino instance
    │       ├── auth/
    │       │   ├── password.ts        # bcrypt hash/compare
    │       │   ├── jwt.ts             # sign/verify, JWT_EXPIRY
    │       │   ├── resolve-auth-context.ts  # token → {employee, roles, permissions} — shared by GraphQL AND ws gateway (FR-90)
    │       │   ├── auth-checker.ts    # TypeGraphQL authChecker over permission keys (FR-3)
    │       │   └── auth.resolver.ts   # login, me (FR-1, FR-4)
    │       ├── loaders/
    │       │   ├── index.ts           # createLoaders(dataSource) — one set per request
    │       │   ├── employee.loader.ts # also backs the "Deleted user" fallback for both booking requester (FR-48) and audit actor (§6)
    │       │   ├── room.loader.ts
    │       │   ├── equipment-by-booking.loader.ts
    │       │   ├── role-permissions.loader.ts
    │       │   └── latest-processing-audit.loader.ts   # FR-40/46: DISTINCT ON per booking
    │       ├── modules/
    │       │   ├── employee/          # entity, inputs, resolver, service, repository
    │       │   ├── rbac/              # role, permission, user-role, role-permission + lockout-guard.ts (FR-17)
    │       │   ├── room/
    │       │   ├── equipment/
    │       │   ├── booking/
    │       │   │   ├── booking.entity.ts
    │       │   │   ├── booking-equipment.entity.ts
    │       │   │   ├── booking.inputs.ts          # CreateBookingInput, BookingFilterInput (class-validator)
    │       │   │   ├── booking.types.ts            # PaginatedBookings, RoomAvailability, EquipmentAvailability
    │       │   │   ├── availability.ts             # ONE derived-availability function (FR-29/35 "same calculation")
    │       │   │   ├── booking.repository.ts       # FOR UPDATE locking, read:own/all scoping (FR-39)
    │       │   │   ├── booking.service.ts          # create/cancel/approve/reject state machine
    │       │   │   ├── booking.resolver.ts
    │       │   │   └── __tests__/
    │       │   ├── audit/             # audit-log.entity (performedBy nullable, §6), audit.service.record(manager,...), repository, read-only resolver
    │       │   ├── notification/      # entity, service, repository, resolver (list/markRead/markAllRead)
    │       │   └── report/            # report.repository.ts (query-builder GROUP BY), report.resolver.ts
    │       ├── realtime/
    │       │   ├── gateway.ts         # plain `ws` server, JWT on handshake via resolve-auth-context (FR-90)
    │       │   ├── connection-registry.ts  # employeeId → live sockets
    │       │   └── events.ts          # typed outbound event payloads
    │       ├── email/
    │       │   ├── email-outbox.entity.ts   # infra addition — see assumption #3
    │       │   ├── email.service.ts         # enqueue(tx, ...) — row written in the same transaction
    │       │   ├── providers/
    │       │   │   ├── sendgrid.provider.ts
    │       │   │   └── noop.provider.ts     # local dev
    │       │   └── dispatcher.ts            # cron-invoked send + retry/backoff
    │       ├── jobs/
    │       │   ├── scheduler.ts             # node-cron registration
    │       │   ├── complete-elapsed-bookings.job.ts   # FR-72
    │       │   ├── send-reminders.job.ts              # FR-74/75
    │       │   └── dispatch-outbound-emails.job.ts    # FR-61/90
    │       └── database/
    │           ├── migrations/
    │           └── seeds/
    │               ├── permissions.seed.ts   # FR-89 catalogue, verbatim
    │               ├── roles.seed.ts         # Admin / Manager / Employee
    │               ├── system-employee.seed.ts  # FR-72, non-loginable, non-deletable
    │               └── admin.seed.ts
    └── client/
        ├── vite.config.ts
        ├── codegen.ts                 # graphql-code-generator client-preset, reads server's schema.graphql
        ├── index.html
        └── src/
            ├── main.tsx
            ├── App.tsx                # router + providers
            ├── apollo/client.ts       # HttpLink + auth link (no ws link — GraphQL is query/mutation only, FR-59)
            ├── graphql/               # codegen output (generated, gitignored)
            ├── auth/                  # AuthProvider, useAuth, usePermission, RequirePermission
            ├── realtime/
            │   ├── ws-client.ts       # token-authenticated WebSocket, reconnect/backoff
            │   └── useNotificationSocket.ts
            ├── components/
            │   ├── DataTable/         # generic, server-side pagination/search/sort/filter (NFR-7)
            │   ├── Form/              # generic, field-schema driven (NFR-7)
            │   ├── layout/            # AppShell, permission-driven Nav, NotificationBell
            │   └── ui/                # Button, Modal, Badge, DateRangePicker
            ├── features/
            │   ├── employees/  ├── roles/  ├── rooms/  ├── equipment/
            │   ├── bookings/          # list, create, detail, approval queue, availability views
            │   ├── notifications/  ├── audit/  └── reports/
            │   └── <each>/{components, hooks, graphql, pages}
            ├── hooks/                 # useTableQuery (table state ↔ GraphQL vars), useDebounce
            ├── lib/                   # date formatting, displayName() → "Deleted user" fallback — used for booking requester (FR-48) AND audit actor (§6), same helper, same code path
            └── styles/                # global.css, variables.css
```

Per-module file convention inside `modules/<name>/` on the server is uniform:
`*.entity.ts → *.inputs.ts → *.repository.ts → *.service.ts → *.resolver.ts → __tests__/`.
This physically encodes §5.2's Resolver → Service → Repository → Database rule — a
resolver file has no reason to import a repository directly, and the convention makes
that visible in code review even without a lint rule.

---

## 2. Build order

### Dependency graph

```
S0 scaffold ─▶ S1 schema/migrations ─▶ S2 auth+RBAC+seed ─▶ S3 cross-cutting infra
                                                                 │
                                            ┌────────────────────┼─────────────────────┐
                                            ▼                    ▼                     ▼
                                        S4 employee/room/equipment   S5 audit core   (schema.graphql emitted)
                                            │                    │                     │
                                            └─────────┬──────────┘                     ▼
                                                       ▼                          C0 client foundation
                                                 S6 booking create/cancel               │
                                                       │                                ▼
                                                       ▼                     C1 generic table/form + CRUD screens
                                                 S7 booking read/detail/availability
                                                       │
                                                       ▼
                                                 S8 approval workflow ───────▶ C2 booking screens
                                                       │
                                                       ▼
                                                 S9 notifications/realtime/email ──▶ C3 notification UI
                                                       │
                                                       ▼
                                                 S10 scheduled jobs
                                                       │
                                                       ▼
                                                 S11 reports ─────────────────▶ C4 audit + reports screens
                                                                                        │
                                                                                        ▼
                                                                                  hardening pass
```

### Server phases

| Phase   | Build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Why here (dependency reasoning)                                                                                                                                                                                                                                                                                                                                                                                                                   | Proof / acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S0**  | Workspaces, tsconfig, `.env`, local Postgres 18 wiring (verified installed: `/Library/PostgreSQL/18/bin`, `psql 18.4`, port 5432 listening), TypeORM DataSource, `create-db` script, health check                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | §5.4 forbids Docker/CI — the only thing to stand up is the already-installed local server. Nothing else can run without a DB connection and a boot path                                                                                                                                                                                                                                                                                           | `npm run dev` boots; `scripts/create-db` creates and connects to a local DB                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **S1**  | All entities from §6, first migration: FKs (nullable `booking.employee_id`, nullable `audit_log.performed_by` — spec-mandated per the §6 update; required `booking.room_id` per FR-31 as updated), enums (booking status, audit action, notification type), NFR-4 indexes (`booking(start_time,end_time)`, `booking(status)`, `booking(employee_id)`, room/equipment FKs), unique index `(booking_id, recipient_id, type)` on notification for FR-75, `email_outbox` table, `btree_gist` exclusion constraint on room+time-range (partial on `status IN ('PENDING','APPROVED')` only, per FR-33/FR-73) as a DB-level backstop                                     | Schema is cheapest to get right before any service depends on it. Delete-behavior and indexes are structural — retrofitting an index or a constraint after data exists means a locking migration on a live table                                                                                                                                                                                                                                  | Migration reversible; `\d booking`/`\d audit_log`/`\d notification` show the required indexes/constraints; deleting an employee who has audit rows or bookings sets those FK columns to null instead of failing or cascading data loss                                                                                                                                                                                                                                                                                                           |
| **S2**  | `resolve-auth-context.ts` (token → identity/roles/permission-union, FR-2/15), `authChecker` (FR-3), `login`/`me` (FR-1/4), Role/Permission CRUD (FR-11-14), lockout guard (FR-17), seeds: FR-89 permission catalogue verbatim, default roles, bootstrap admin, non-loginable system employee (FR-72)                                                                                                                                                                                                                                                                                                                                                              | FR-2/3 gate _every_ subsequent operation — the guard must exist before the first guarded resolver. `resolve-auth-context` is written as a standalone function (not inline in the Apollo context callback) specifically because S9's WebSocket handshake must reuse it verbatim (FR-90) — building it generically now avoids a rewrite later. Seeding solves the bootstrap problem: FR-5 says admins create employees, so one admin must pre-exist | Login issues a JWT; `me` returns the permission-key union across roles; a forbidden op returns an error with no record data; revoking a permission takes effect on the very next request (FR-16) with no restart; last `role:assign` holder cannot be removed (FR-17); system employee cannot log in                                                                                                                                                                                                                                             |
| **S3**  | `PageArgs`/`Paginated<T>`/sort whitelist (NFR-2), class-validator error formatter → field errors (NFR-6), `runInTransaction` with `tx.afterCommit()` (NFR-3, FR-90), DataLoader context wiring, `schema.graphql` emission on boot                                                                                                                                                                                                                                                                                                                                                                                                                                 | S4's first list resolver needs the pagination contract; S6's first transaction needs `afterCommit`; the client (C0) needs `schema.graphql` to exist before codegen can run — doing this now unblocks both server and client tracks in parallel                                                                                                                                                                                                    | Pagination clamps page size and returns `totalCount`; invalid mutation input returns `fieldErrors`, not a 500; a callback registered via `afterCommit` fires once on commit and zero times on rollback (unit test with a forced rollback)                                                                                                                                                                                                                                                                                                        |
| **S4**  | Employee (FR-5-10, hard delete per FR-7 with self/system-account guard), Room (FR-18-22 — FR-23 availability view implemented in S7 with Booking; no partial version built, isActive is filterable now via `activeOnly` so S6 can exclude inactive rooms), Equipment (FR-24-28 — FR-29 remaining-free-quantity view implemented in S7 with Booking, per FR-29's own requirement that the displayed figure reuse the booking engine's availability calculation; no partial version built, isActive is filterable now via `activeOnly` so S6 can exclude inactive equipment) — CRUD, pagination, search, sort, `activeOnly` filter for booking selection (FR-20/26) | Lowest-risk modules; they exercise the Resolver→Service→Repository pattern and the S3 pagination contract three times before Booking (the highest-risk module) needs them as FK targets. Booking literally cannot be built without a Room and Equipment table to reference                                                                                                                                                                        | Duplicate email rejected as a field error; deleting an employee with existing bookings leaves those bookings queryable with `employee: null` (rendered as "Deleted user" by the shared `displayName()` helper); employee list with roles resolves in a constant number of SQL statements regardless of row count (NFR-1 proof via query-count assertion)                                                                                                                                                                                         |
| **S5**  | `AuditLog` entity (`performedBy` nullable per §6), `AuditService.record(manager, ...)` (accepts the caller's `EntityManager`, never opens its own transaction), admin search resolver (FR-65), read-only — no update/delete resolver exists (FR-64)                                                                                                                                                                                                                                                                                                                                                                                                               | FR-63 requires the audit row to be written **inside** the same transaction as the state change. Booking's create/cancel/approve/reject transactions (S6/S8) all call into this service, so it must exist and be transaction-agnostic before the first caller is written                                                                                                                                                                           | A test transaction that calls `record()` then throws leaves zero rows in `audit_log` (proves it shares the caller's transaction, not its own); no GraphQL mutation exists for AuditLog; deleting the employee who performed a historical action leaves the audit row intact with `performedBy: null`, and the resolver renders "Deleted user" via the same `employee.loader.ts` fallback path used for booking requesters — one test proves both call sites use the identical helper                                                             |
| **S6**  | Booking create + cancel: `availability.ts` (single derived-availability function per FR-29/35's "same calculation" requirement), overlap/capacity checks (FR-32-34), `FOR UPDATE` row locking ordered by id on room/equipment (FR-36), owner-cancel gated by `booking:cancel:own` restricted to PENDING (FR-37), manager-cancel via `booking:cancel:any` extended to PENDING+APPROVED (assumption #2), CREATE/CANCEL audit rows via S5                                                                                                                                                                                                                            | This is the highest-risk logic in the system (concurrency + business rules) and is deliberately isolated from approval/notifications so concurrency tests stay narrowly scoped. `availability.ts` is written once here and **imported, not reimplemented,** by S7's read views and S8's re-validation — this is what makes FR-29's "never diverge" guarantee actually true in code rather than by convention                                      | Concurrency test: N parallel `createBooking` calls for the last free room slot / last equipment unit → exactly one succeeds, others get a domain error, not a 500 or a double-booked row; back-to-back bookings (end == start) succeed; a 1-second overlap is rejected; a rolled-back attempt leaves no row in `booking`, `booking_equipment`, or `audit_log`                                                                                                                                                                                    |
| **S7**  | Booking list/detail/availability reads: repository scoping by `read:own`/`read:all` (FR-39), search via `EXISTS` joins on requester/room/equipment/purpose/status (FR-41), filters (FR-42), loaders for employee/room/equipment-lines/latest-processing-audit (FR-40/46), `statusHistory` from AuditLog with actor resolved through the same nullable-`performedBy` fallback (FR-47, §6), requester summary + recent bookings with "Deleted user" fallback (FR-48), room/equipment availability views reusing `availability.ts` from S6 (FR-23/29), employee booking history field (completes FR-10)                                                              | Needs booking rows to exist (depends on S6) and reuses S6's availability function rather than re-deriving it                                                                                                                                                                                                                                                                                                                                      | Query-count assertion proves a 25-row page issues a constant number of SQL statements regardless of N (NFR-1); 100k-row seed + `EXPLAIN ANALYZE` shows index scans and p95 < 500ms (NFR-4); a `booking:read:own` caller cannot fetch another employee's booking even by direct id (FR-39/FR-3); the equipment-availability figure shown here is byte-identical to what S6's create check enforces (same function, single test proves it); a status-history entry whose actor employee was later deleted renders "Deleted user", not a null crash |
| **S8**  | Approval workflow: pending queue ordered by `createdAt` (FR-50), approve with re-validation via S6's same `availability.ts` inside a **new** transaction (FR-51/52), reject with configurable min-length reason (FR-54), refuse non-PENDING (FR-55), block self-approval **and** self-rejection (FR-56), APPROVE/REJECT audit rows                                                                                                                                                                                                                                                                                                                                | Depends on S6 (reuses its validators) and S5 (audit); approval is explicitly a second, independent transaction per FR-52 ("resource position may have changed"), so it cannot be built as part of S6                                                                                                                                                                                                                                              | Test: booking A approved; concurrently booking B for the same slot is approved first; A's approval then fails re-validation with a surfaced reason, not a generic 500; rejecting with a reason shorter than `REJECTION_REASON_MIN_LENGTH` is rejected; approving an already-APPROVED booking returns a domain error; the creator of a booking cannot approve or reject it                                                                                                                                                                        |
| **S9**  | `realtime/gateway.ts` (plain `ws`, JWT on handshake via S2's `resolve-auth-context`), notification records for requester (approve/reject/cancel-by-other, FR-57) and managers (new PENDING, FR-58), unread count + mark-read/mark-all-read (FR-59/60), `email-outbox` enqueue + SendGrid/no-op provider + retry dispatcher (FR-61), both emission paths wired through S3's `afterCommit` so they fire only post-commit (FR-90)                                                                                                                                                                                                                                    | Depends on S6/S8 transitions to notify about, and on S3's `afterCommit` hook to satisfy the "never from within the transaction" rule. This is the first consumer of the WS gateway, so it's built here rather than earlier where nothing would use it                                                                                                                                                                                             | Integration test: approve a booking → a WS message is received by a connected client and an outbox row exists, both only _after_ the DB transaction commits (a forced post-audit, pre-commit failure produces neither); a provider that throws leaves the booking APPROVED (not rolled back) and the outbox row's attempt count increments (FR-61)                                                                                                                                                                                               |
| **S10** | `complete-elapsed-bookings` (APPROVED past `endTime` → COMPLETED, audited as the system employee, FR-72), `send-reminders` (FR-74, idempotent via `NOT EXISTS` on a `REMINDER`-type notification plus the unique index from S1, FR-75)                                                                                                                                                                                                                                                                                                                                                                                                                            | Depends on the status machine (S6/S8), audit (S5), the system employee seed (S2), and notifications (S9) for reminders — every dependency must exist first                                                                                                                                                                                                                                                                                        | Each job run twice over an identical window produces zero new rows on the second run (FR-75 proof by literal repeated execution); completed bookings disappear from `availability.ts` results automatically with no separate release code path (FR-73)                                                                                                                                                                                                                                                                                           |
| **S11** | Report resolvers via TypeORM query builder with DB-side `GROUP BY` (FR-66-70)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Pure reads with zero coupling to any write path; needs realistic seeded data (bookings across statuses/months) to be meaningful, so it's left until data-producing phases exist                                                                                                                                                                                                                                                                   | Generated SQL contains `GROUP BY`/aggregate functions and no in-app aggregation; report totals match hand-computed values from a fixed seed fixture                                                                                                                                                                                                                                                                                                                                                                                              |

### Client phases

| Phase     | Build                                                                                                                                                                                                                                                                | Depends on                           | Proof                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C0**    | Vite + React + TS scaffold, `graphql-code-generator` against `schema.graphql`, Apollo Client (`HttpLink` + auth link only — no ws link, since GraphQL is query/mutation-only per FR-59), login page, `AuthProvider`, `usePermission`, permission-driven route guards | S3 (schema emission) + S2 (login/me) | Login → `me` populates permission set → nav renders only permitted items; codegen produces typed hooks with no manual `gql` typing                                                                                                                                                                                                                                                                                                                  |
| **C1**    | Generic `DataTable` (server pagination/search/sort/filter, dynamic columns) and `Form` (field-schema driven), `lib/displayName()` fallback helper, applied first to Employee/Role/Room/Equipment screens                                                             | S4                                   | Four unrelated list screens import the _same_ `DataTable` component; server field errors from S3 render inline on the same `Form` component (NFR-6/7 proven by reuse, not by separate implementations)                                                                                                                                                                                                                                              |
| **C2**    | Booking create/list/detail, approval queue, availability views                                                                                                                                                                                                       | S6, S7, S8                           | Successful create shows the booking's UUID + PENDING status on-screen (FR-38); approve/reject controls are hidden without the permission client-side, but a direct mutation call from a non-permitted session is still rejected server-side (proves NFR-5's "client hiding is not the enforcement point"); status-history rows and requester summaries reuse `lib/displayName()` for both audit actor and requester — one component, two call sites |
| **C3**    | `ws-client.ts` (JWT-authenticated, reconnect/backoff), `NotificationBell`, mark-read                                                                                                                                                                                 | S9                                   | Two browser sessions for the same user: an action in one updates the unread count in the other without a page refresh                                                                                                                                                                                                                                                                                                                               |
| **C4**    | Audit log screen, report screens                                                                                                                                                                                                                                     | S5, S11                              | Audit filters (booking/actor/action/status/date range) map directly to server args; reports render the aggregated rows without client-side recomputation                                                                                                                                                                                                                                                                                            |
| **Final** | 100k-row load test, index verification via `EXPLAIN ANALYZE`, security pass (confirm `password` has no `@Field` anywhere in the schema, JWT expiry enforced), README with local Postgres setup instructions, `AGENTS.md` updated with real commands                  | Everything                           | NFR-4 measured and met; introspecting the deployed schema shows no `password` field on `Employee`                                                                                                                                                                                                                                                                                                                                                   |

---

## 3. Traceability (every requirement mapped to a phase)

| Requirement range                                            | Phase                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| FR-1–4 (auth, `me`), NFR-5                                   | S2                                                     |
| FR-5–10 (employee)                                           | S4 (FR-10's booking-history sub-field completes in S7) |
| FR-11–17, FR-89 (RBAC + catalogue)                           | S2                                                     |
| FR-18–23 (room + availability)                               | S4 create/CRUD; FR-23 availability view in S7          |
| FR-24–29 (equipment + availability)                          | S4 create/CRUD; FR-29 availability figure in S7        |
| FR-30–38 (booking create/cancel)                             | S6                                                     |
| FR-39–43 (booking list)                                      | S7                                                     |
| FR-45–49 (booking detail, incl. audit-actor fallback per §6) | S7                                                     |
| FR-50–56 (approval)                                          | S8                                                     |
| FR-57–61, FR-90 (notifications, realtime, email)             | S9                                                     |
| FR-62–65 (audit, `performedBy` nullable per §6)              | S5                                                     |
| FR-66–70 (reports)                                           | S11                                                    |
| FR-72–75 (scheduled jobs)                                    | S10                                                    |
| NFR-1 (N+1)                                                  | Established in S3, proven in S4/S7                     |
| NFR-2 (pagination)                                           | S3                                                     |
| NFR-3 (transactions)                                         | S3 mechanism; S6/S8 usage                              |
| NFR-4 (performance/indexes)                                  | S1 indexes; S7 load test                               |
| NFR-6 (validation)                                           | S3                                                     |
| NFR-7 (generic components)                                   | C1                                                     |
| NFR-8 (auditability)                                         | S5                                                     |

All 75 FRs and 8 NFRs map to exactly one build phase; none are orphaned, none are
duplicated across phases in a way that would let two implementations of the same rule
(e.g., availability, or the "Deleted user" display fallback) drift apart.
