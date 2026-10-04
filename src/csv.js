// Objects/arrays (json, jsonb, array columns) are serialized as JSON; null becomes an empty unquoted cell,
// while an empty string is written as "" so the two survive a round trip.
function cell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text === '' || /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function columnsOf(rows) {
  const seen = new Set();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

export function toCsv(rows, columns = columnsOf(rows)) {
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function parseCsv(text) {
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let wasQuoted = false;
  const endField = () => {
    row.push(wasQuoted || field !== '' ? field : null);
    field = '';
    wasQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else inQuotes = false;
    } else if (ch === '"') {
      inQuotes = true;
      wasQuoted = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endField();
      records.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || wasQuoted || row.length) {
    endField();
    records.push(row);
  }
  const [header, ...data] = records;
  if (!header) return [];
  return data.map((values) => Object.fromEntries(header.map((h, i) => [h, values[i] ?? null])));
}
