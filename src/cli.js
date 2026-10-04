import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, redact } from './config.js';
import { createClient } from './http.js';
import { discoverTables, exportTables, readBackup, restoreTable, prune } from './backup.js';

const USAGE = `Usage:
  supabase-table-backup export  (--tables a,b | --all) [--out ./backups] [--format json|csv]
                                [--page-size 1000] [--order id|<column>|none]
  supabase-table-backup restore --from ./backups/<stamp> (--tables a,b | --all)
                                [--upsert] [--batch 500] [--dry-run] [--yes]
  supabase-table-backup prune   --dir ./backups --keep 7

Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY) from the
environment or a .env file in the current directory.`;

const BOOLEAN_FLAGS = new Set(['all', 'upsert', 'dry-run', 'yes', 'help']);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    let [name, value] = arg.slice(2).split(/=(.*)/s);
    if (BOOLEAN_FLAGS.has(name)) {
      opts[name] = true;
      continue;
    }
    if (value === undefined) {
      value = rest[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    }
    opts[name] = value;
  }
  return { command, opts };
}

function positiveInt(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

const listOf = (value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : []);

export async function run(argv, { env = process.env, cwd = process.cwd(), fetchImpl, out = console.log, sleep } = {}) {
  const { command, opts } = parseArgs(argv);
  if (!command || opts.help || command === 'help' || command === '--help') {
    out(USAGE);
    return 0;
  }

  if (command === 'prune') {
    if (!opts.dir) throw new Error('prune requires --dir');
    const keep = positiveInt(opts.keep, 'keep', 7);
    const removed = await prune(resolve(cwd, opts.dir), keep);
    out(removed.length ? `Removed ${removed.length} backup(s): ${removed.join(', ')}` : 'Nothing to prune.');
    return 0;
  }

  if (command !== 'export' && command !== 'restore') throw new Error(`Unknown command "${command}".\n\n${USAGE}`);

  const config = loadConfig({ env, cwd });
  const client = createClient({ ...config, fetchImpl, sleep });
  let tables = listOf(opts.tables);

  if (command === 'export') {
    if (opts.all) tables = await discoverTables(client);
    if (!tables.length) throw new Error('export requires --tables a,b or --all');
    const format = opts.format || 'json';
    if (format !== 'json' && format !== 'csv') throw new Error('--format must be json or csv');
    const { dir } = await exportTables(client, {
      tables,
      out: resolve(cwd, opts.out || './backups'),
      format,
      pageSize: positiveInt(opts['page-size'], 'page-size', 1000),
      order: opts.order || 'id',
      log: out,
    });
    out(`Backup written to ${dir}`);
    return 0;
  }

  if (!opts.from) throw new Error('restore requires --from <backup folder>');
  const dryRun = Boolean(opts['dry-run']);
  if (!dryRun && !opts.yes) {
    throw new Error('restore writes to your database. Re-run with --yes to confirm, or use --dry-run first.');
  }
  const from = resolve(cwd, opts.from);
  if (opts.all) {
    const manifest = JSON.parse(await readFile(resolve(from, 'manifest.json'), 'utf8'));
    tables = manifest.tables.map((t) => t.table);
  }
  if (!tables.length) throw new Error('restore requires --tables a,b or --all');
  const batch = positiveInt(opts.batch, 'batch', 500);
  for (const table of tables) {
    const rows = await readBackup(from, table);
    await restoreTable(client, table, rows, { batch, upsert: Boolean(opts.upsert), dryRun, log: out });
  }
  out(dryRun ? 'Dry run complete; nothing was written.' : 'Restore complete.');
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    process.exitCode = await run(argv);
  } catch (err) {
    let key = '';
    try {
      key = loadConfig().key;
    } catch {
      key = '';
    }
    console.error(`Error: ${redact(err.message, key)}`);
    process.exitCode = 1;
  }
}
