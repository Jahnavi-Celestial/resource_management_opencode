# AGENTS.md

## Project Status

S0 (scaffold) and S1 (schema + first migration) are complete per docs/PLAN.md.
Domain services/resolvers, GraphQL, and the client are not started yet.

## Commands

npm run typecheck      # tsc --noEmit across all workspaces
npm run create-db      # ensure the local database exists
npm run migrate        # apply pending TypeORM migrations
npm run migrate:revert # revert the last applied migration
npm run check-schema   # verify entity metadata matches the live schema (no drift)
npm run dev            # boot server; health check at http://localhost:4000/health

Local PostgreSQL 18 (EDB install) at `/Library/PostgreSQL/18/bin`, port 5432 —
no Docker/CI per docs/requirements.md §5.4. DB credentials come from `.env`
(see `.env.example`).

## Architecture notes

- Migrations are handwritten and reversible in
  `apps/server/src/database/migrations/`; `synchronize` stays `false` (S0 rule).
- Shared enums live in `packages/shared/src` (booking-status, notification-type);
  permission keys will be added there in S2.
- Entities use explicit snake_case column names and `foreignKeyConstraintName`,
  matching the migration DDL 1:1 so `check-schema` reports no drift.
- `btree_gist` is created/dropped by the first migration for the booking
  room+time-range exclusion constraint (FR-33 backstop).
- tsconfig is fully strict; entity properties use `!` because TypeORM populates
  them at runtime.
