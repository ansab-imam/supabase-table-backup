import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[match[1]] = value;
  }
  return out;
}

// Real environment variables win over .env so CI secrets cannot be shadowed by a stray file.
export function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const envPath = join(cwd, '.env');
  const fromFile = existsSync(envPath) ? parseDotenv(readFileSync(envPath, 'utf8')) : {};
  const pick = (name) => env[name] || fromFile[name] || '';
  const url = pick('SUPABASE_URL').replace(/\/+$/, '');
  const key = pick('SUPABASE_SERVICE_ROLE_KEY') || pick('SUPABASE_KEY');
  if (!url) throw new Error('SUPABASE_URL is not set (environment or .env file).');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY) is not set (environment or .env file).');
  if (!/^https?:\/\//.test(url)) throw new Error('SUPABASE_URL must start with http:// or https://');
  return { url, key };
}

export function redact(text, key) {
  let out = String(text);
  if (key) out = out.split(key).join('[REDACTED]');
  // Also catch JWT-shaped tokens that are not the configured key, e.g. echoed in a proxy error page.
  return out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[REDACTED]');
}
