import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockPostgrest } from './mock-server.js';
import { createClient } from '../src/http.js';
import { exportTables, restoreTable, readBackup, prune, discoverTables, timestamp, parseContentRange } from '../src/backup.js';
import { toCsv, parseCsv } from '../src/csv.js';
import { parseDotenv, loadConfig, redact } from '../src/config.js';
import { run } from '../src/cli.js';

const tmp = () => mkdtemp(join(tmpdir(), 'stb-'));
const noSleep = async () => {};
const leads = Array.from({ length: 2500 }, (_, i) => ({ id: 2500 - i, name: `Lead ${2500 - i}` }));

test('export paginates across several pages and writes a hashed manifest', async (t) => {
  const mock = await startMockPostgrest({ tables: { leads, deals: [{ id: 1, amount: 10 }] } });
  t.after(() => mock.close());
  const out = await tmp();
  const client = createClient({ url: mock.url, key: mock.key, sleep: noSleep });
  const now = new Date('2026-10-03T12:00:00.123Z');

  const { dir, manifest } = await exportTables(client, { tables: ['leads', 'deals'], out, pageSize: 1000, now });

  assert.equal(dir, join(out, '2026-10-03T12-00-00Z'));
  const ranges = mock.state.requests.filter((r) => r.path === '/rest/v1/leads').map((r) => r.headers.range);
  assert.deepEqual(ranges, ['0-999', '1000-1999', '2000-2999']);
  assert.ok(mock.state.requests.every((r) => r.path === '/rest/v1/' || r.headers.prefer === 'count=exact'));
  assert.match(mock.state.requests[0].search, /order=id\.asc/);

  const saved = JSON.parse(await readFile(join(dir, 'leads.json'), 'utf8'));
  assert.equal(saved.length, 2500);
  assert.deepEqual(saved.slice(0, 2).map((r) => r.id), [1, 2]);

  const onDisk = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(onDisk, manifest);
  for (const entry of manifest.tables) {
    const data = await readFile(join(dir, entry.file));
    assert.equal(entry.sha256, createHash('sha256').update(data).digest('hex'));
  }
  assert.deepEqual(manifest.tables.map((t) => [t.table, t.rows]), [['leads', 2500], ['deals', 1]]);
});

test('export of an empty table finishes after one request', async (t) => {
  const mock = await startMockPostgrest({ tables: { empty: [] } });
  t.after(() => mock.close());
  const client = createClient({ url: mock.url, key: mock.key, sleep: noSleep });
  const { manifest } = await exportTables(client, { tables: ['empty'], out: await tmp() });
  assert.equal(manifest.tables[0].rows, 0);
  assert.equal(mock.state.requests.length, 1);
});

test('csv escaping handles commas, quotes, newlines, nulls and json', () => {
  const rows = [
    { id: 1, note: 'plain', meta: null },
    { id: 2, note: 'has, comma', meta: { a: 1 } },
    { id: 3, note: 'say "hi"', meta: [1, 2] },
    { id: 4, note: 'line1\nline2', meta: '' },
  ];
  const csv = toCsv(rows);
  assert.equal(
    csv,
    'id,note,meta\r\n1,plain,\r\n2,"has, comma","{""a"":1}"\r\n3,"say ""hi""","[1,2]"\r\n4,"line1\nline2",""\r\n',
  );
  const back = parseCsv(csv);
  assert.equal(back[1].note, 'has, comma');
  assert.equal(back[2].note, 'say "hi"');
  assert.equal(back[3].note, 'line1\nline2');
  assert.equal(back[0].meta, null);
  assert.equal(back[3].meta, '');
});

test('csv export goes through the CLI and restores from csv', async (t) => {
  const mock = await startMockPostgrest({ tables: { deals: [{ id: 1, title: 'A, "big" one' }] } });
  t.after(() => mock.close());
  const cwd = await tmp();
  const env = { SUPABASE_URL: mock.url, SUPABASE_KEY: mock.key };
  const logs = [];
  await run(['export', '--tables', 'deals', '--out', 'b', '--format', 'csv'], { env, cwd, out: (m) => logs.push(m), sleep: noSleep });
  const [stamp] = await readdir(join(cwd, 'b'));
  const rows = await readBackup(join(cwd, 'b', stamp), 'deals');
  assert.deepEqual(rows, [{ id: '1', title: 'A, "big" one' }]);
});

test('restore sends batches with the right Prefer headers', async (t) => {
  const mock = await startMockPostgrest({ tables: { leads: [] } });
  t.after(() => mock.close());
  const client = createClient({ url: mock.url, key: mock.key, sleep: noSleep });
  const rows = leads.slice(0, 1201);

  assert.equal(await restoreTable(client, 'leads', rows, { batch: 500, dryRun: true }), 1201);
  assert.equal(mock.state.posts.length, 0);

  await restoreTable(client, 'leads', rows, { batch: 500, upsert: true });
  assert.deepEqual(mock.state.posts.map((p) => p.rows.length), [500, 500, 201]);
  assert.ok(mock.state.posts.every((p) => p.prefer.includes('resolution=merge-duplicates')));

  mock.state.posts.length = 0;
  await restoreTable(client, 'leads', rows.slice(0, 3), { batch: 2 });
  assert.ok(mock.state.posts.every((p) => !p.prefer.includes('merge-duplicates')));
});

test('restore via CLI requires --yes and rejects tampered files', async (t) => {
  const mock = await startMockPostgrest({ tables: { leads: leads.slice(0, 5) } });
  t.after(() => mock.close());
  const cwd = await tmp();
  const env = { SUPABASE_URL: mock.url, SUPABASE_SERVICE_ROLE_KEY: mock.key };
  const opts = { env, cwd, out: () => {}, sleep: noSleep };
  await run(['export', '--tables', 'leads', '--out', 'b'], opts);
  const [stamp] = await readdir(join(cwd, 'b'));
  const from = join('b', stamp);

  await assert.rejects(run(['restore', '--from', from, '--tables', 'leads'], opts), /--yes/);
  await run(['restore', '--from', from, '--tables', 'leads', '--dry-run'], opts);
  assert.equal(mock.state.posts.length, 0);
  await run(['restore', '--from', from, '--all', '--yes', '--batch', '2'], opts);
  assert.deepEqual(mock.state.posts.map((p) => p.rows.length), [2, 2, 1]);

  await writeFile(join(cwd, from, 'leads.json'), '[]');
  await assert.rejects(run(['restore', '--from', from, '--tables', 'leads', '--yes'], opts), /Checksum mismatch/);
});

test('--all discovers tables from the OpenAPI root and skips rpc paths', async (t) => {
  const mock = await startMockPostgrest({ tables: { leads: [], deals: [] } });
  t.after(() => mock.close());
  const client = createClient({ url: mock.url, key: mock.key, sleep: noSleep });
  assert.deepEqual(await discoverTables(client), ['deals', 'leads']);
});

test('retries 5xx with backoff, then succeeds', async (t) => {
  const mock = await startMockPostgrest({ tables: { deals: [{ id: 1 }] }, failFirst: 2 });
  t.after(() => mock.close());
  const delays = [];
  const client = createClient({ url: mock.url, key: mock.key, baseDelayMs: 100, sleep: async (ms) => delays.push(ms) });
  const { manifest } = await exportTables(client, { tables: ['deals'], out: await tmp() });
  assert.equal(manifest.tables[0].rows, 1);
  assert.deepEqual(delays, [100, 200]);
});

test('clear errors for 401 and missing tables', async (t) => {
  const mock = await startMockPostgrest({ tables: {} });
  t.after(() => mock.close());
  const bad = createClient({ url: mock.url, key: 'wrong', sleep: noSleep });
  await assert.rejects(exportTables(bad, { tables: ['x'], out: await tmp() }), /Unauthorized \(HTTP 401\)/);
  const good = createClient({ url: mock.url, key: mock.key, sleep: noSleep });
  await assert.rejects(exportTables(good, { tables: ['nope'], out: await tmp() }), /Table "nope" not found/);
});

test('prune keeps the newest N timestamped folders and ignores everything else', async () => {
  const dir = await tmp();
  const stamps = ['2026-10-01T00-00-00Z', '2026-10-02T00-00-00Z', '2026-10-03T00-00-00Z', '2026-09-30T00-00-00Z'];
  for (const s of [...stamps, 'keep-me', '2026-10-01']) await mkdir(join(dir, s));
  await writeFile(join(dir, '2026-01-01T00-00-00Z.txt'), 'x');
  const removed = await prune(dir, 2);
  assert.deepEqual(removed, ['2026-09-30T00-00-00Z', '2026-10-01T00-00-00Z']);
  assert.deepEqual((await readdir(dir)).sort(), ['2026-01-01T00-00-00Z.txt', '2026-10-01', '2026-10-02T00-00-00Z', '2026-10-03T00-00-00Z', 'keep-me']);
  await rm(dir, { recursive: true });
});

test('timestamp and Content-Range helpers', () => {
  assert.equal(timestamp(new Date('2026-10-03T12:00:00.999Z')), '2026-10-03T12-00-00Z');
  assert.equal(parseContentRange('0-999/2500'), 2500);
  assert.equal(parseContentRange('*/0'), 0);
  assert.equal(parseContentRange('0-9/*'), null);
  assert.equal(parseContentRange(null), null);
});

test('.env parsing and precedence', async () => {
  const parsed = parseDotenv('# comment\nexport A=1\nB="two words"\nC=\'x#y\'\nD=bare # trailing\n\nbad line\n');
  assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'x#y', D: 'bare' });

  const cwd = await tmp();
  await writeFile(join(cwd, '.env'), 'SUPABASE_URL=https://your-project-ref.supabase.co/\nSUPABASE_KEY=from-file\n');
  assert.deepEqual(loadConfig({ env: {}, cwd }), { url: 'https://your-project-ref.supabase.co', key: 'from-file' });
  assert.equal(loadConfig({ env: { SUPABASE_SERVICE_ROLE_KEY: 'from-env' }, cwd }).key, 'from-env');
  const emptyDir = await tmp();
  assert.throws(() => loadConfig({ env: {}, cwd: emptyDir }), /SUPABASE_URL is not set/);
});

test('redact hides the configured key and JWT-shaped tokens', () => {
  const key = 'super-secret-value';
  assert.equal(redact(`bad key super-secret-value here`, key), 'bad key [REDACTED] here');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJl';
  assert.equal(redact(`token ${jwt}`, ''), 'token [REDACTED]');
});

test('key never appears in error messages from the API', async (t) => {
  const key = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJl';
  const fetchImpl = async () => new Response(JSON.stringify({ message: `rejected ${key}` }), { status: 400 });
  const client = createClient({ url: 'https://your-project-ref.supabase.co', key, fetchImpl, sleep: noSleep });
  const err = await exportTables(client, { tables: ['x'], out: await tmp() }).catch((e) => e);
  assert.ok(!redact(err.message, key).includes(key));
});
