# AGENTS.md

## Project Status

S0 (scaffold), S1 (schema + first migration), and S2 (auth, RBAC, seeds) are
complete per docs/PLAN.md, and the S2 acceptance suite
(`npm run test:s2`) passes. Client and S3+ are not started yet.

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
