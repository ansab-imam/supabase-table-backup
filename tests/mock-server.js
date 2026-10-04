import { createServer } from 'node:http';

// A minimal in-process stand-in for PostgREST: enough of GET (Range/Content-Range), POST and the OpenAPI root.
export async function startMockPostgrest({ tables = {}, key = 'test-key', failFirst = 0 } = {}) {
  const state = { tables, posts: [], requests: [], failuresLeft: failFirst };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    state.requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers });
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    if (req.headers.apikey !== key || req.headers.authorization !== `Bearer ${key}`) {
      return send(401, { message: 'Invalid API key' });
    }
    if (state.failuresLeft > 0) {
      state.failuresLeft--;
      return send(503, { message: 'temporarily unavailable' });
    }

    const name = decodeURIComponent(url.pathname.replace(/^\/rest\/v1\/?/, ''));
    if (name === '' && req.method === 'GET') {
      const definitions = Object.fromEntries(Object.keys(state.tables).map((t) => [t, { type: 'object' }]));
      const paths = { '/': {}, '/rpc/some_function': {} };
      for (const t of Object.keys(state.tables)) paths[`/${t}`] = {};
      return send(200, { swagger: '2.0', definitions, paths });
    }
    if (!(name in state.tables)) return send(404, { code: '42P01', message: `relation "public.${name}" does not exist` });

    if (req.method === 'GET') {
      let rows = [...state.tables[name]];
      const order = url.searchParams.get('order');
      if (order) {
        const [col] = order.split('.');
        rows.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0));
      }
      const total = rows.length;
      const [from, to] = (req.headers.range || `0-${Math.max(total - 1, 0)}`).split('-').map(Number);
      const page = rows.slice(from, to + 1);
      const range = page.length ? `${from}-${from + page.length - 1}/${total}` : `*/${total}`;
      return send(page.length < total ? 206 : 200, page, { 'Content-Range': range });
    }

    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      state.posts.push({ table: name, rows: JSON.parse(raw), prefer: req.headers.prefer || '' });
      return send(201);
    }
    return send(405, { message: 'method not allowed' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    key,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
