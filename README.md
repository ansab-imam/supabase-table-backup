# supabase-table-backup

Back up Supabase tables to JSON or CSV files, and restore them, using nothing but the Supabase REST API (PostgREST) and Node's built-in `fetch`.

- Zero runtime dependencies. No `supabase-js`, no `pg_dump`, no Docker, no direct database connection.
- Built for the free plan, where you want simple scheduled data exports without managing database credentials.
- Each run writes a timestamped folder with one file per table and a `manifest.json` containing row counts and SHA-256 checksums.

## Install

Requires Node.js 18 or newer.

```bash
git clone https://github.com/ansab-imam/supabase-table-backup.git
cd supabase-table-backup
npm link
supabase-table-backup --help
```

Or run it without installing:

```bash
npx github:ansab-imam/supabase-table-backup export --tables leads,deals
```

## Configuration

Set these environment variables, or put them in a `.env` file in the directory you run the command from (see `.env.example`):

| Variable | Description |
| --- | --- |
| `SUPABASE_URL` | Your project URL, e.g. `https://your-project-ref.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (recommended for complete backups) |
| `SUPABASE_KEY` | Used if `SUPABASE_SERVICE_ROLE_KEY` is not set, e.g. an anon key for RLS-limited exports |

Real environment variables take precedence over `.env`. The key is never printed, and it is redacted from error messages.

## Commands

### export

```bash
supabase-table-backup export --tables leads,deals --out ./backups
supabase-table-backup export --tables leads --format csv --page-size 500
supabase-table-backup export --all --out ./backups
supabase-table-backup export --tables events --order created_at
```

| Option | Default | Description |
| --- | --- | --- |
| `--tables a,b` | | Comma-separated table (or view) names |
| `--all` | | Discover every table and view from the PostgREST OpenAPI root |
| `--out <dir>` | `./backups` | Parent folder for the timestamped backup |
| `--format json\|csv` | `json` | Output format |
| `--page-size <n>` | `1000` | Rows per request |
| `--order <column>` | `id` | Column to sort by while paging; `none` disables ordering |

Rows are fetched page by page with `Range-Unit: items` / `Range: 0-999` headers and `Prefer: count=exact`, and the total from `Content-Range` decides when to stop.

**Ordering matters.** Without a stable sort order, PostgreSQL may return rows in a different order between page requests, so a page could skip or repeat rows. By default results are sorted by `id`. If a table has no `id` column, pass `--order <column>` with a unique column (for example a primary key or `created_at` together with low write traffic). `--order` applies to every table in the run, so back up tables with different keys in separate runs. Use `--order none` only for small tables that fit in one page.

Supabase limits a single response to "Max rows" (1000 by default, under API settings). Keep `--page-size` at or below that limit.

**`--all` needs schema visibility.** Table names are read from the OpenAPI document served at `GET /rest/v1/` (the `definitions` and `paths` keys). That document only lists objects your key is allowed to see, so use the service role key. Newer Supabase projects may restrict the OpenAPI endpoint for anon keys entirely. Functions (`/rpc/*`) are skipped.

### restore

```bash
# See what would be sent, without writing anything
supabase-table-backup restore --from ./backups/2026-10-03T12-00-00Z --tables leads --dry-run

# Insert rows (fails on duplicate primary keys)
supabase-table-backup restore --from ./backups/2026-10-03T12-00-00Z --tables leads --yes

# Insert or update existing rows, 200 per request, every table in the backup
supabase-table-backup restore --from ./backups/2026-10-03T12-00-00Z --all --upsert --batch 200 --yes
```

| Option | Default | Description |
| --- | --- | --- |
| `--from <dir>` | | A timestamped backup folder |
| `--tables a,b` / `--all` | | Tables to restore; `--all` uses every table in `manifest.json` |
| `--upsert` | off | Send `Prefer: resolution=merge-duplicates` so rows with existing primary keys are updated |
| `--batch <n>` | `500` | Rows per POST request |
| `--dry-run` | off | Read and validate the files, report what would be sent, write nothing |
| `--yes` | | Required for any restore that writes |

Before restoring, each file's SHA-256 is checked against `manifest.json`; a mismatch aborts the restore. Tables are restored in the order given, so list parent tables before tables with foreign keys to them. Restoring from CSV sends every value as a string (empty cells as `null`); PostgreSQL casts them to the column types, but prefer JSON backups if you plan to restore.

### prune

```bash
supabase-table-backup prune --dir ./backups --keep 7
```

Deletes all but the newest `--keep` backup folders. Only folders whose names match the timestamp pattern `YYYY-MM-DDTHH-MM-SSZ` are considered; any other file or folder in `--dir` is left alone.

## Output layout

```
backups/
  2026-10-03T12-00-00Z/
    leads.json
    deals.json
    manifest.json
```

`manifest.json`:

```json
{
  "exported_at": "2026-10-03T12:00:00.000Z",
  "format": "json",
  "tables": [
    { "table": "leads", "file": "leads.json", "rows": 2500, "sha256": "9f2c...", "exported_at": "2026-10-03T12:00:01.204Z" }
  ]
}
```

Timestamps are UTC and use dashes instead of colons so folder names are valid on Windows. CSV files use RFC 4180 quoting with CRLF line endings; JSON and array columns are written as JSON text.

## Scheduling with GitHub Actions

[`examples/backup.yml`](examples/backup.yml) runs a nightly export and uploads the backup folder as a workflow artifact. It is kept in `examples/` so it does not run in this repository.

1. Use a **private** repository. Workflow artifacts can be downloaded by anyone with read access to the repository.
2. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as repository secrets (Settings > Secrets and variables > Actions).
3. Copy the file to `.github/workflows/backup.yml` and adjust the cron schedule, format and `retention-days`.

## Security

> **The service role key bypasses row-level security.** Anyone holding it can read, change and delete every row in every exposed table. Treat it like a database password.

- Never commit it. `.env` is in `.gitignore`; keep it that way.
- In CI, use GitHub Actions secrets (or your platform's equivalent), never plain environment values in the workflow file.
- Never ship it to a browser or a mobile app.
- Backup files contain your data in plain text. Store them somewhere private, and encrypt them if they hold personal data.
- If a key leaks, rotate it in the Supabase dashboard immediately.

## Limitations

This tool backs up **table data only**. It does not back up:

- schema (table definitions, indexes, constraints, RLS policies, triggers)
- database functions, view definitions, extensions
- Storage buckets and files
- Auth users (`auth.users`) or anything outside the schemas exposed through the API

Other things to be aware of:

- Each table is read in pages; it is not a single consistent snapshot across tables or pages if data changes during the export.
- Very large tables are held in memory while being written.
- Generated and identity columns may reject explicit values on restore, depending on how they are defined.

For full, point-in-time database backups use `pg_dump` or Supabase's paid backup features.

## Errors and retries

Requests that fail with HTTP 429 or 5xx, or with a network error, are retried up to 4 times with exponential backoff (0.5s, 1s, 2s, 4s), honoring `Retry-After` when present. 401/403 responses report a key problem, and 404 reports a missing table.

## Running tests

```bash
npm test
```

The tests use `node:test` and an in-process mock PostgREST server; they make no network calls to Supabase.

## License

MIT © 2026 Socialist Fox. See [LICENSE](LICENSE).
