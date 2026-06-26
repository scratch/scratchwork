# Migrations

Incremental, ordered SQL deltas applied **before** [`../schema.sql`](../schema.sql)
by both the local runner ([`../migrate.js`](../migrate.js)) and the production
deploy ([`../../../deploy.sh`](../../../deploy.sh), via `wrangler d1 execute`).

`schema.sql` is the source of truth for a fresh database and is fully idempotent
(`IF NOT EXISTS` everywhere). You only need a file here when a change cannot be
expressed that way — typically an `ALTER TABLE … ADD COLUMN`, a data backfill,
or a drop/rename on an existing database.

## Conventions

- Name files `NNNN_short_description.sql`, zero-padded and incrementing
  (`0001_add_project_theme.sql`). They run in filename order.
- Write each migration to be safe to re-run. The runner tolerates errors whose
  message contains `already exists` or `duplicate column` and skips them, so an
  already-applied delta is a no-op. Anything else aborts the run.
- After adding a migration, make the same change in `schema.sql` so new
  databases are created correct in one shot.

There are no deltas yet: the initial database is created entirely from
`schema.sql`.
