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
FR-23, FR-29) are all complete and their acceptance suites pass.
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
npm run dev            # boot server; GraphQL at http://localhost:3000/graphql,
                       # health check at http://localhost:3000/health

Local PostgreSQL 18 (EDB install) at `/Library/PostgreSQL/18/bin`, port 5432 —
no Docker/CI per docs/requirements.md §5.4. DB credentials come from `.env`
(see `.env.example`).

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
