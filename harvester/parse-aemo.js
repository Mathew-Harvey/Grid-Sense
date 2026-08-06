// Parser for AEMO's nested report format.
//
// NEMWeb files are not CSV. Every line carries a record-type prefix:
//
//   C  comment / header / footer
//   I  column definitions for a (report, subreport, version) triple
//   D  a data row, to be mapped against the most recent matching I row
//
// A single file routinely contains several unrelated tables. PUBLIC_DISPATCHIS
// carries six. So the schema is keyed by the triple, not held as one global
// header.
//
// On the END OF REPORT count: it is the TOTAL LINE COUNT of the file — C rows
// and I rows and the footer line itself all included — not the number of data
// rows. Verified against three report types; see FLAGS.md F1. Reading it as a
// data-row count throws on every file AEMO has ever published.

/**
 * Split one line of AEMO's format into fields.
 *
 * Hand-rolled rather than split(',') because fields are double-quoted whenever
 * they contain a comma, and timestamps ("2026/08/06 23:00:00") always are. A
 * naive split appears to work right up until a constraint description or a
 * market notice contains a comma, at which point every field after it shifts by
 * one and the row silently decodes into garbage.
 *
 * Quoting follows RFC 4180: quotes only special at field start, "" is a literal
 * quote inside a quoted field.
 */
export function splitLine(line) {
  const fields = [];
  let i = 0;
  const n = line.length;

  while (i <= n) {
    if (i === n) { fields.push(''); break; }

    if (line[i] === '"') {
      // Quoted field: scan to the closing quote, honouring "" as an escape.
      let value = '';
      i++;
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { value += '"'; i += 2; continue; }
          i++;
          break;
        }
        value += line[i++];
      }
      fields.push(value);
      if (i < n && line[i] === ',') { i++; continue; }
      if (i >= n) break;
      // Trailing junk after a closing quote is malformed; keep it rather than
      // discard, so the row-shape assertion downstream catches it loudly.
      let tail = '';
      while (i < n && line[i] !== ',') tail += line[i++];
      if (tail) fields[fields.length - 1] += tail;
      if (i < n) i++;
      continue;
    }

    let value = '';
    while (i < n && line[i] !== ',') value += line[i++];
    fields.push(value);
    if (i < n && line[i] === ',') { i++; continue; }
    break;
  }

  return fields;
}

const NUMERIC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/**
 * AEMO timestamps are "YYYY/MM/DD HH:MM:SS" in NEM time, which is AEST
 * (UTC+10) permanently — it does not observe daylight saving, ever, in any
 * region. Parsed by hand rather than via Date so no host timezone and no DST
 * rule can touch it.
 *
 * @param {string} s
 * @param {number} utcOffsetHours 10 for NEM (AEST), 8 for WEM (AWST)
 * @returns {number|null} UTC epoch ms
 */
export function parseAemoTimestamp(s, utcOffsetHours = 10) {
  if (!s) return null;
  const m = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, sec ? +sec : 0) - utcOffsetHours * 3600_000;
}

/**
 * Parse an AEMO nested-format report.
 *
 * @param {string} text  full file contents
 * @param {object} [opts]
 * @param {boolean} [opts.validateCount=true] enforce the END OF REPORT assertion
 * @param {Set<string>} [opts.tables] only materialise these "REPORT.SUBREPORT" keys
 * @returns {{tables: Map<string, {report,subreport,version,columns,rows}>, lineCount: number, declaredCount: number|null}}
 */
export function parseAemo(text, opts = {}) {
  const { validateCount = true, tables: wanted = null } = opts;

  const lines = text.split(/\r?\n/);
  const schemas = new Map();   // "REPORT.SUBREPORT.VERSION" -> columns[]
  const tables = new Map();    // "REPORT.SUBREPORT" -> table
  let lineCount = 0;
  let declaredCount = null;
  let sawFooter = false;

  for (const raw of lines) {
    if (raw === '') continue;          // trailing newline, not a record
    const kind = raw[0];

    if (kind === 'C') {
      lineCount++;
      // Footer looks like: C,"END OF REPORT",516
      if (raw.includes('END OF REPORT')) {
        const f = splitLine(raw);
        const n = Number(f[f.length - 1]);
        if (Number.isFinite(n)) { declaredCount = n; sawFooter = true; }
      }
      continue;
    }

    if (kind === 'I') {
      lineCount++;
      const f = splitLine(raw);
      const [, report, subreport, version] = f;
      schemas.set(`${report}.${subreport}.${version}`, f.slice(4));
      continue;
    }

    if (kind === 'D') {
      lineCount++;
      const f = splitLine(raw);
      const [, report, subreport, version] = f;
      const key = `${report}.${subreport}`;
      if (wanted && !wanted.has(key)) continue;

      const columns = schemas.get(`${report}.${subreport}.${version}`);
      if (!columns) {
        throw new Error(
          `Data row for ${report}.${subreport} v${version} with no preceding I row. ` +
          `File is truncated or the record order is not what the format guarantees.`
        );
      }

      const values = f.slice(4);
      if (values.length > columns.length) {
        throw new Error(
          `Row shape mismatch in ${report}.${subreport} v${version}: ` +
          `${values.length} values against ${columns.length} columns. ` +
          `Most likely an unquoted comma inside a field.`
        );
      }

      const row = {};
      for (let c = 0; c < columns.length; c++) {
        const v = values[c];
        // Undefined-vs-empty matters: AEMO omits trailing fields when a newer
        // schema version adds columns a given row does not populate.
        row[columns[c]] = v === undefined || v === ''
          ? null
          : (NUMERIC.test(v) ? Number(v) : v);
      }

      let table = tables.get(key);
      if (!table) {
        table = { report, subreport, version: Number(version), columns, rows: [] };
        tables.set(key, table);
      }
      table.rows.push(row);
      continue;
    }

    // Anything else is not a record type this format defines.
    throw new Error(`Unrecognised record type ${JSON.stringify(kind)} in AEMO report`);
  }

  if (validateCount) {
    if (!sawFooter) {
      throw new Error('No "END OF REPORT" footer: file is truncated or the download was cut short.');
    }
    if (lineCount !== declaredCount) {
      throw new Error(
        `END OF REPORT count mismatch: footer declares ${declaredCount} lines, parsed ${lineCount}. ` +
        `Note this count includes C and I rows and the footer itself (see FLAGS.md F1).`
      );
    }
  }

  return { tables, lineCount, declaredCount };
}
