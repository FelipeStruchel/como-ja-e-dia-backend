#!/bin/sh
set -e
# ONE-TIME MANUAL BASELINE REQUIRED ON THE PRODUCTION VPS BEFORE THE NEXT DEPLOY.
#
# This used to run `prisma db push --accept-data-loss`, which diffs schema.prisma
# against the live DB and pushes schema changes directly — it never reads or
# executes anything under prisma/migrations/, so no migration's data statements
# (backfills, deletes, etc.) have ever actually run in production. We're switching
# to `prisma migrate deploy` so migrations apply for real going forward. Do NOT
# run both `db push` and `migrate deploy` — mixing them causes drift between the
# schema and Prisma's internal `_prisma_migrations` tracking table.
#
# Because `_prisma_migrations` has never been populated (only `db push` ran
# before), and the live DB's schema is almost certainly already ahead of
# migration history (from prior `db push` runs), the operator MUST baseline
# every existing migration whose SCHEMA changes are already present in the live
# DB — likely all of them — by running, for each one in order:
#   ./node_modules/.bin/prisma migrate resolve --applied <migration_name>
# BEFORE the first `migrate deploy` runs. Otherwise `migrate deploy` will try to
# re-apply schema changes that already exist and fail.
#
# IMPORTANT: baselining a migration marks it applied WITHOUT running its SQL —
# including any data-only statements (backfills, deletes) in OLDER migrations.
# Baselining will silently skip those forever. If any pending data-only
# statements from older migrations still matter (check prisma/migrations/*/migration.sql
# for INSERT/UPDATE/DELETE statements not implied by the schema diff alone),
# the operator must separately verify whether they already ran and manually
# apply them if not, before or after baselining.
./node_modules/.bin/prisma migrate deploy
if [ -f prisma/seed.js ]; then
  node prisma/seed.js
fi
exec npm start
