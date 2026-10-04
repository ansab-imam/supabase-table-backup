import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { toCsv, parseCsv } from './csv.js';

export const STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

// Colons are not allowed in Windows paths, so the ISO time uses dashes.
export function timestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function parseContentRange(header) {
  const match = /^(?:\d+-\d+|\*)\/(\d+|\*)$/.exec((header || '').trim());
  return match && match[1] !== '*' ? Number(match[1]) : null;
}

export async function discoverTables(client) {
  const res = await client.request('', { headers: { Accept: 'application/openapi+json' } });
  const spec = await res.json();
  const names = new Set(Object.keys(spec.definitions || {}));
  for (const path of Object.keys(spec.paths || {})) {
    const name = path.replace(/^\//, '');
    if (name && !name.startsWith('rpc/')) names.add(name);
  }
  return [...names].sort();
}

export async function fetchTable(client, table, { pageSize = 1000, order = 'id' } = {}) {
  const rows = [];
  const orderParam = order && order !== 'none' ? `&order=${encodeURIComponent(order)}.asc` : '';
  let total = null;
  for (let offset = 0; total === null || offset < total; offset += pageSize) {
    const res = await client.request(`${encodeURIComponent(table)}?select=*${orderParam}`, {
      table,
      headers: { 'Range-Unit': 'items', Range: `${offset}-${offset + pageSize - 1}`, Prefer: 'count=exact' },
    });
    const page = await res.json();
    rows.push(...page);
    const reported = parseContentRange(res.headers.get('content-range'));
    if (reported !== null) total = reported;
    // Stop on a short or empty page so a server that omits Content-Range cannot cause an endless loop.
    if (page.length < pageSize) break;
  }
  return rows;
}

export async function exportTables(client, { tables, out, format = 'json', pageSize = 1000, order = 'id', now = new Date(), log = () => {} }) {
  const dir = join(out, timestamp(now));
  await mkdir(dir, { recursive: true });
  const manifest = { exported_at: now.toISOString(), format, tables: [] };
  for (const table of tables) {
    const rows = await fetchTable(client, table, { pageSize, order });
    const data = format === 'csv' ? toCsv(rows) : JSON.stringify(rows, null, 2) + '\n';
    const file = `${table}.${format}`;
    await writeFile(join(dir, file), data);
    manifest.tables.push({ table, file, rows: rows.length, sha256: sha256(data), exported_at: new Date().toISOString() });
    log(`${table}: ${rows.length} rows -> ${file}`);
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { dir, manifest };
}

export async function readBackup(dir, table) {
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    manifest = null;
  }
  const entry = manifest?.tables?.find((t) => t.table === table);
  const candidates = entry ? [entry.file] : [`${table}.json`, `${table}.csv`];
  for (const file of candidates) {
    let data;
    try {
      data = await readFile(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    if (entry && sha256(data) !== entry.sha256) {
      throw new Error(`Checksum mismatch for ${file}; the backup file was modified or is corrupted.`);
    }
    return file.endsWith('.csv') ? parseCsv(data) : JSON.parse(data);
  }
  throw new Error(`No backup file for table "${table}" in ${dir}`);
}

export async function restoreTable(client, table, rows, { batch = 500, upsert = false, dryRun = false, log = () => {} } = {}) {
  let sent = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    if (!dryRun) {
      const prefer = ['return=minimal'];
      if (upsert) prefer.push('resolution=merge-duplicates');
      await client.request(encodeURIComponent(table), {
        method: 'POST',
        table,
        headers: { 'Content-Type': 'application/json', Prefer: prefer.join(',') },
        body: JSON.stringify(chunk),
      });
    }
    sent += chunk.length;
    log(`${table}: ${dryRun ? 'would send' : 'sent'} ${sent}/${rows.length}`);
  }
  return sent;
}

export async function prune(dir, keep) {
  const entries = await readdir(dir, { withFileTypes: true });
  // Timestamps sort lexically in chronological order, so the oldest come first.
  const stamps = entries.filter((e) => e.isDirectory() && STAMP_PATTERN.test(e.name)).map((e) => e.name).sort();
  const removed = stamps.slice(0, Math.max(0, stamps.length - keep));
  for (const name of removed) await rm(join(dir, name), { recursive: true });
  return removed;
}
