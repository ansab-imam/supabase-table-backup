export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const isRetryable = (status) => status === 429 || status >= 500;

export function createClient({ url, key, fetchImpl = globalThis.fetch, retries = 4, baseDelayMs = 500, sleep }) {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function request(path, { method = 'GET', headers = {}, body, table } = {}) {
    const target = `${url}/rest/v1/${path}`;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(target, {
          method,
          headers: { apikey: key, Authorization: `Bearer ${key}`, ...headers },
          body,
        });
      } catch (err) {
        if (attempt >= retries) throw new ApiError(`Network error on ${method} /rest/v1/${path}: ${err.message}`, 0);
        await wait(baseDelayMs * 2 ** attempt);
        continue;
      }
      if (res.ok) return res;
      if (isRetryable(res.status) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await res.arrayBuffer().catch(() => {});
        await wait(retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt);
        continue;
      }
      throw await toError(res, method, path, table);
    }
  }

  return { request };
}

async function toError(res, method, path, table) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = json.message || json.hint || text;
    } catch {
      detail = text;
    }
  } catch {
    detail = '';
  }
  const suffix = detail ? `: ${detail.slice(0, 300)}` : '';
  if (res.status === 401 || res.status === 403) {
    return new ApiError(`Unauthorized (HTTP ${res.status}). Check SUPABASE_SERVICE_ROLE_KEY / SUPABASE_KEY${suffix}`, res.status);
  }
  if (res.status === 404) {
    const what = table ? `Table "${table}" not found` : `Not found: /rest/v1/${path}`;
    return new ApiError(`${what}. Check the name and that it is in an exposed schema${suffix}`, res.status);
  }
  return new ApiError(`${method} /rest/v1/${path} failed with HTTP ${res.status}${suffix}`, res.status);
}
