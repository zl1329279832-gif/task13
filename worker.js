/* ============================================================
   worker.js — CSV parsing, profiling, rule execution engine
   Runs entirely off main thread for performance.
   ============================================================ */

/* ---------- message router ---------- */
self.onmessage = function (e) {
  const { task, id, payload } = e.data;
  const send = (data, transfer) => self.postMessage({ id, ...data }, transfer || []);
  try {
    switch (task) {
      case 'parse': {
        const { headers, rows, parseErrors } = parseCSV(payload.text, payload.config);
        const profile = profileDataset(headers, rows);
        send({ success: true, headers, rows, profile, parseErrors: parseErrors || [] });
        break;
      }
      case 'profile': {
        const profile = profileDataset(payload.headers, payload.rows);
        send({ success: true, profile });
        break;
      }
      case 'executeRules': {
        const result = executeRules(payload.headers, payload.rows, payload.rules, payload.allDatasets);
        send({ success: true, ...result });
        break;
      }
      case 'crossValidate': {
        const result = crossValidate(payload.datasets, payload.rules);
        send({ success: true, result });
        break;
      }
      case 'computeFingerprint': {
        const fingerprints = computeColumnFingerprints(payload.headers, payload.rows, payload.profiles);
        send({ success: true, fingerprints });
        break;
      }
      case 'executeRecipeStep': {
        const { headers, rows, rule, allDatasets } = payload;
        const profileBefore = profileDataset(headers, rows);
        const stepHeaders = headers.slice();
        const stepRows = rows.map(r => r.slice());
        const result = executeOneRule(stepHeaders, stepRows, rule, allDatasets);
        const newHeaders = result.headers || stepHeaders;
        const newRows = result.rows || stepRows;
        const profileAfter = profileDataset(newHeaders, newRows);
        send({
          success: true,
          headers: newHeaders,
          rows: newRows,
          profileBefore,
          profileAfter,
          affectedCount: result.affectedCount || 0,
          changes: (result.changes || []).slice(0, 200),
          affectedRows: (result.affectedRows || []).slice(0, 100),
          error: result.error || null
        });
        break;
      }
      default:
        send({ success: false, error: 'Unknown task: ' + task });
    }
  } catch (err) {
    send({ success: false, error: err.message || String(err) });
  }
};

/* ============================================================
   CSV PARSER — handles quoted fields, embedded commas, newlines,
   smart quotes, malformed rows, duplicate headers
   ============================================================ */

/* --- Quote character helpers --- */
function isOpenQuote(ch) {
  return ch === '"' || ch === '\u201c'; // " or LEFT DOUBLE QUOTATION MARK
}

function isCloseQuote(ch, openChar) {
  if (openChar === '"') return ch === '"';
  if (openChar === '\u201c') return ch === '\u201d' || ch === '"'; // accept RIGHT or straight
  return ch === '"' || ch === '\u201d';
}

function isAnyQuote(ch) {
  return ch === '"' || ch === '\u201c' || ch === '\u201d';
}

function parseCSV(text, config) {
  config = config || {};
  const delimiter = config.delimiter || detectDelimiter(text);
  const hasHeader = config.hasHeader !== false;
  const parseErrors = [];

  const rows = [];
  let i = 0;
  const len = text.length;
  let currentRow = 0;

  function parseField() {
    if (i >= len) return '';

    if (isAnyQuote(text[i])) {
      const openChar = text[i];
      i++;
      let field = '';
      let closed = false;
      const startRow = currentRow;

      while (i < len) {
        const ch = text[i];

        if (isCloseQuote(ch, openChar)) {
          // Check for escaped (doubled) quote
          if (i + 1 < len && isAnyQuote(text[i + 1])) {
            field += '"'; // collapsed to standard double-quote
            i += 2;
          } else {
            i++; // skip closing quote
            closed = true;
            break;
          }
        } else if (ch === '\n' || ch === '\r') {
          // Allow embedded newlines in quoted fields, but detect unclosed quotes
          // Heuristic: if we see too many consecutive newlines, it's likely unclosed
          let nlCount = 0, la = i;
          while (la < len && (text[la] === '\n' || text[la] === '\r')) { nlCount++; la++; }
          if (nlCount > 50) {
            parseErrors.push({ row: startRow, message: 'Unclosed quote; treating as unquoted at line boundary' });
            break;
          }
          field += ch;
          i++;
        } else {
          field += ch;
          i++;
        }
      }

      if (!closed && i >= len) {
        parseErrors.push({ row: startRow, message: 'Unclosed quote at end of file' });
      }

      // Skip any junk after closing quote until delimiter or newline
      if (closed && i < len && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') {
        let junkLen = 0;
        while (i < len && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') {
          junkLen++;
          i++;
        }
        if (junkLen > 0) {
          parseErrors.push({ row: startRow, message: 'Junk after closing quote (' + junkLen + ' chars skipped)' });
        }
      }

      return field;
    } else {
      // Unquoted field
      let field = '';
      while (i < len && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') {
        field += text[i];
        i++;
      }
      return field;
    }
  }

  function parseRow() {
    const row = [];
    while (i < len) {
      const field = parseField();
      row.push(field);
      if (i >= len) break;
      if (text[i] === delimiter) {
        i++;
        if (i >= len || text[i] === '\n' || text[i] === '\r') {
          row.push(''); // trailing delimiter → empty field
        }
        continue;
      }
      if (text[i] === '\r') {
        i++;
        if (i < len && text[i] === '\n') i++;
        break;
      }
      if (text[i] === '\n') {
        i++;
        break;
      }
    }
    return row;
  }

  // Skip BOM
  if (text.charCodeAt(0) === 0xFEFF) i++;

  while (i < len) {
    // Skip blank lines
    if (text[i] === '\n' || text[i] === '\r') {
      if (text[i] === '\r' && i + 1 < len && text[i + 1] === '\n') i += 2;
      else i++;
      continue;
    }
    const row = parseRow();
    if (row.length > 0 && !(row.length === 1 && row[0] === '')) {
      rows.push(row);
    }
    currentRow++;
  }

  // Separate headers from data
  let headers;
  let dataRows;
  if (hasHeader && rows.length > 0) {
    headers = rows[0];
    dataRows = rows.slice(1);
  } else {
    const colCount = rows.length > 0 ? rows[0].length : 0;
    headers = Array.from({ length: colCount }, (_, j) => 'Column_' + (j + 1));
    dataRows = rows;
  }

  // Handle duplicate column names: append _2, _3, etc.
  const headerSeen = new Map();
  for (let h = 0; h < headers.length; h++) {
    const orig = headers[h].trim();
    headers[h] = orig;
    if (headerSeen.has(orig)) {
      const count = headerSeen.get(orig) + 1;
      headerSeen.set(orig, count);
      headers[h] = orig + '_' + count;
      parseErrors.push({ row: 0, message: 'Duplicate column "' + orig + '" -> "' + headers[h] + '"' });
    } else {
      headerSeen.set(orig, 1);
    }
  }

  // Normalize row lengths to match header count
  const colCount = headers.length;
  for (let r = 0; r < dataRows.length; r++) {
    if (dataRows[r].length < colCount) {
      while (dataRows[r].length < colCount) dataRows[r].push('');
    } else if (dataRows[r].length > colCount) {
      parseErrors.push({
        row: r + 1,
        message: 'Row has ' + dataRows[r].length + ' fields, expected ' + colCount + '; truncated'
      });
      dataRows[r] = dataRows[r].slice(0, colCount);
    }
  }

  return { headers, rows: dataRows, parseErrors };
}

function detectDelimiter(text) {
  const candidates = [',', '\t', ';', '|'];
  const sample = text.slice(0, 4096);
  const lines = sample.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return ',';

  let bestDelim = ',';
  let bestScore = -1;

  for (const d of candidates) {
    const counts = lines.map(l => {
      let count = 0;
      let inQuote = false;
      for (let i = 0; i < l.length; i++) {
        if (isAnyQuote(l[i])) inQuote = !inQuote;
        else if (l[i] === d && !inQuote) count++;
      }
      return count;
    });
    if (counts[0] === 0) continue;
    const consistent = counts.every(c => c === counts[0]);
    const score = counts[0] * (consistent ? 10 : 1);
    if (score > bestScore) {
      bestScore = score;
      bestDelim = d;
    }
  }
  return bestDelim;
}

/* ============================================================
   PROFILER — detect types, nulls, duplicates, dirty data
   ============================================================ */
const DATE_PATTERNS = [
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/,
  /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/,
  /^\d{4}年\d{1,2}月\d{1,2}日$/,
  /^\d{8}$/,
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}[T ]\d{1,2}:\d{2}/,
  /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}[T ]\d{1,2}:\d{2}/,
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[\d\s\-+()]{7,15}$/;
const BOOL_VALUES = new Set(['true', 'false', 'yes', 'no', '1', '0', '是', '否', 'y', 'n', 't', 'f']);

// Money patterns: ¥100, $1,234.56, €100, £50, ￥100, 100元, 100万
const MONEY_PREFIX_RE = /^[¥$€£￥]\s*-?\d[\d,，.]*\d*$/;
const MONEY_SUFFIX_RE = /^-?\d[\d,，.]*\d*\s*[元万千百块]$/;

function profileDataset(headers, rows) {
  const n = rows.length;
  const profiles = headers.map((h, ci) => profileColumn(h, ci, rows));

  // Detect duplicate rows
  const rowMap = new Map();
  const duplicateIndices = [];
  for (let r = 0; r < n; r++) {
    const key = rows[r].join('\x00');
    if (rowMap.has(key)) {
      duplicateIndices.push(r);
    } else {
      rowMap.set(key, r);
    }
  }

  // Primary key detection
  for (const p of profiles) {
    if (p.nullCount === 0 && p.uniqueCount === n && n > 0) {
      p.isPrimaryKey = true;
    }
  }

  // Quality score
  const totalCells = n * headers.length;
  let totalNulls = 0;
  for (const p of profiles) totalNulls += p.nullCount;
  let completeness = totalCells > 0 ? 1 - totalNulls / totalCells : 1;
  let uniqueness = n > 0 ? 1 - duplicateIndices.length / n : 1;
  let validity = 0, validTotal = 0;
  for (const p of profiles) {
    if (p.type !== 'string') {
      validTotal += p.validCount + p.dirtyCount;
      validity += p.validCount;
    }
  }
  let validityScore = validTotal > 0 ? validity / validTotal : 1;
  let quality = Math.round((completeness * 0.3 + uniqueness * 0.3 + validityScore * 0.4) * 100);

  return {
    rowCount: n,
    columnCount: headers.length,
    profiles,
    duplicateCount: duplicateIndices.length,
    duplicateIndices: duplicateIndices.slice(0, 200),
    quality,
    qualityBreakdown: {
      completeness: Math.round(completeness * 100),
      uniqueness: Math.round(uniqueness * 100),
      validity: Math.round(validityScore * 100),
    },
  };
}

function profileColumn(header, colIdx, rows) {
  const n = rows.length;
  let nullCount = 0, intCount = 0, floatCount = 0, dateCount = 0;
  let emailCount = 0, phoneCount = 0, boolCount = 0, dirtyCount = 0, moneyCount = 0;
  const valueCounts = new Map();
  const sampleValues = [];
  const dirtySamples = [];

  for (let r = 0; r < n; r++) {
    const raw = rows[r][colIdx];
    const v = raw == null ? '' : String(raw).trim();

    if (v === '' || v.toLowerCase() === 'null' || v.toLowerCase() === 'na' || v === 'N/A' || v === 'n/a' || v === '-' || v.toLowerCase() === 'none' || v.toLowerCase() === 'nan' || v.toLowerCase() === 'nil') {
      nullCount++;
      continue;
    }

    valueCounts.set(v, (valueCounts.get(v) || 0) + 1);
    if (sampleValues.length < 5) sampleValues.push(v);

    const isInt = /^-?\d+$/.test(v);
    const isFloat = /^-?\d+\.\d+$/.test(v) || /^-?\.\d+$/.test(v);
    if (isInt) intCount++;
    else if (isFloat) floatCount++;
    if (DATE_PATTERNS.some(p => p.test(v))) dateCount++;
    if (EMAIL_RE.test(v)) emailCount++;
    if (PHONE_RE.test(v) && v.replace(/\D/g, '').length >= 7) phoneCount++;
    if (BOOL_VALUES.has(v.toLowerCase()) || BOOL_VALUES.has(v)) boolCount++;
    if (MONEY_PREFIX_RE.test(v) || MONEY_SUFFIX_RE.test(v)) moneyCount++;

    if ((raw !== v && raw !== undefined && raw !== null) || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(raw || '')) {
      dirtyCount++;
      if (dirtySamples.length < 10) dirtySamples.push({ row: r, value: raw });
    }
  }

  const nonNull = n - nullCount;
  const uniqueCount = valueCounts.size;

  let type = 'string', typeConfidence = 0;
  if (nonNull > 0) {
    const candidates = [
      { type: 'integer', count: intCount },
      { type: 'float', count: floatCount },
      { type: 'money', count: moneyCount },
      { type: 'date', count: dateCount },
      { type: 'email', count: emailCount },
      { type: 'phone', count: phoneCount },
      { type: 'boolean', count: boolCount },
    ].filter(c => c.count > 0).sort((a, b) => b.count - a.count);

    if (candidates.length > 0) {
      typeConfidence = Math.round(candidates[0].count / nonNull * 100);
      // Lowered threshold from 50% to 40% to catch type drift scenarios
      if (typeConfidence >= 40) type = candidates[0].type;
    }

    // Type drift detection: if top 2 types together cover >80% but neither >60%
    if (candidates.length >= 2) {
      const topTwo = candidates[0].count + candidates[1].count;
      if (topTwo / nonNull > 0.8 && candidates[0].count / nonNull < 0.6) {
        type = 'mixed';
        typeConfidence = Math.round(candidates[0].count / nonNull * 100);
      }
    }
  }

  let isEnum = false;
  if (uniqueCount > 0 && uniqueCount <= 20 && nonNull > uniqueCount * 2) isEnum = true;

  let enumValues = null;
  if (isEnum) {
    enumValues = [...valueCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([value, count]) => ({ value, count }));
  }

  return {
    column: header, colIdx, type, typeConfidence,
    nullCount, nullRate: n > 0 ? Math.round(nullCount / n * 100) : 0,
    uniqueCount, isEnum, isPrimaryKey: false, enumValues,
    validCount: nonNull - dirtyCount, dirtyCount, sampleValues, dirtySamples,
  };
}

/* ============================================================
   RULE EXECUTOR
   ============================================================ */
function executeRules(headers, rows, rules, allDatasets) {
  headers = headers.slice();
  rows = rows.map(r => r.slice());

  const logs = [];
  const errorRows = new Set();
  let totalAffected = 0;

  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri];
    if (rule.enabled === false) continue;

    const result = executeOneRule(headers, rows, rule, allDatasets);
    if (result.headers) headers = result.headers;
    if (result.rows) rows = result.rows;
    if (result.affectedRows) {
      for (const idx of result.affectedRows) errorRows.add(idx);
    }

    logs.push({
      ruleIndex: ri, ruleType: rule.type,
      ruleName: rule.name || rule.type,
      affectedCount: result.affectedCount || 0,
      errorRows: (result.affectedRows || []).slice(0, 100),
      changes: (result.changes || []).slice(0, 200),
      status: result.error ? 'error' : 'ok',
      error: result.error || null,
    });
    totalAffected += result.affectedCount || 0;
  }

  const profileAfter = profileDataset(headers, rows);

  return { headers, rows, logs, totalAffected, errorRows: [...errorRows].slice(0, 500), profileAfter };
}

function executeOneRule(headers, rows, rule, allDatasets) {
  switch (rule.type) {
    case 'dedup': return ruleDedup(headers, rows, rule);
    case 'nullFill': return ruleNullFill(headers, rows, rule);
    case 'fieldSplit': return ruleFieldSplit(headers, rows, rule);
    case 'dateNormalize': return ruleDateNormalize(headers, rows, rule);
    case 'amountConvert': return ruleAmountConvert(headers, rows, rule);
    case 'enumMap': return ruleEnumMap(headers, rows, rule);
    case 'crossValidate': return ruleCrossValidate(headers, rows, rule, allDatasets);
    case 'rename': return ruleRename(headers, rows, rule);
    case 'trim': return ruleTrim(headers, rows, rule);
    default: return { error: 'Unknown rule type: ' + rule.type };
  }
}

/* --- Dedup --- */
function ruleDedup(headers, rows, rule) {
  const cols = rule.columns;
  const colIdxs = cols ? cols.map(c => headers.indexOf(c)).filter(i => i >= 0) : headers.map((_, i) => i);
  const keep = rule.keep || 'first';
  const seen = new Map();
  const toRemove = new Set();
  const changes = [];

  for (let r = 0; r < rows.length; r++) {
    const key = colIdxs.map(i => rows[r][i]).join('\x00');
    if (seen.has(key)) {
      if (keep === 'first') {
        toRemove.add(r);
        changes.push({ row: r, type: 'remove', detail: 'duplicate of row ' + (seen.get(key) + 1) });
      } else {
        toRemove.add(seen.get(key));
        changes.push({ row: seen.get(key), type: 'remove', detail: 'duplicate of row ' + (r + 1) });
        seen.set(key, r);
      }
    } else {
      seen.set(key, r);
    }
  }

  const newRows = rows.filter((_, i) => !toRemove.has(i));
  return { rows: newRows, affectedCount: toRemove.size, affectedRows: [...toRemove].slice(0, 100), changes };
}

/* --- Null Fill --- */
function ruleNullFill(headers, rows, rule) {
  const ci = headers.indexOf(rule.column);
  if (ci < 0) return { error: 'Column not found: ' + rule.column };
  const method = rule.method;
  const changes = [], affectedRows = [];
  let fillValue = rule.fillValue != null ? String(rule.fillValue) : '';

  if (method === 'mean' || method === 'median') {
    const nums = [];
    for (const row of rows) {
      const v = parseFloat(row[ci]);
      if (!isNaN(v) && row[ci].trim() !== '') nums.push(v);
    }
    if (nums.length > 0) {
      nums.sort((a, b) => a - b);
      fillValue = method === 'mean'
        ? String(Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 100) / 100)
        : String(nums[Math.floor(nums.length / 2)]);
    }
  } else if (method === 'mode') {
    const freq = new Map();
    for (const row of rows) {
      const v = row[ci].trim();
      if (v !== '') freq.set(v, (freq.get(v) || 0) + 1);
    }
    let maxV = '', maxC = 0;
    for (const [v, c] of freq) { if (c > maxC) { maxC = c; maxV = v; } }
    fillValue = maxV;
  }

  for (let r = 0; r < rows.length; r++) {
    const v = rows[r][ci].trim();
    if (v === '' || v.toLowerCase() === 'null' || v.toLowerCase() === 'na' || v === 'N/A') {
      if (method === 'forward') {
        fillValue = r > 0 ? rows[r - 1][ci] : '';
      } else if (method === 'backward') {
        for (let rr = r + 1; rr < rows.length; rr++) {
          const vv = rows[rr][ci].trim();
          if (vv !== '' && vv.toLowerCase() !== 'null') { fillValue = vv; break; }
        }
      }
      if (fillValue !== '') {
        changes.push({ row: r, col: ci, before: rows[r][ci], after: fillValue });
        rows[r][ci] = fillValue;
        affectedRows.push(r);
      }
    }
  }

  return { rows, affectedCount: affectedRows.length, affectedRows, changes };
}

/* --- Field Split --- */
function ruleFieldSplit(headers, rows, rule) {
  const ci = headers.indexOf(rule.column);
  if (ci < 0) return { error: 'Column not found: ' + rule.column };
  const delimiter = rule.delimiter || ',';
  const newNames = rule.newColumns || [];
  const changes = [], affectedRows = [];

  let maxParts = 1;
  for (const row of rows) {
    const parts = row[ci].split(delimiter);
    if (parts.length > maxParts) maxParts = parts.length;
  }

  const colNames = [];
  for (let i = 0; i < maxParts; i++) colNames.push(newNames[i] || (rule.column + '_' + (i + 1)));

  const newHeaders = headers.slice();
  newHeaders.splice(ci + 1, 0, ...colNames);

  for (let r = 0; r < rows.length; r++) {
    const parts = rows[r][ci].split(delimiter).map(s => s.trim());
    const newCols = [];
    for (let i = 0; i < maxParts; i++) newCols.push(parts[i] || '');
    const newRow = rows[r].slice();
    newRow.splice(ci + 1, 0, ...newCols);
    rows[r] = newRow;
    if (parts.length > 1) {
      affectedRows.push(r);
      changes.push({ row: r, col: ci, before: rows[r][ci], after: newCols.join(' | ') });
    }
  }

  return { headers: newHeaders, rows, affectedCount: affectedRows.length, affectedRows, changes };
}

/* --- Date Normalize --- */
function ruleDateNormalize(headers, rows, rule) {
  const ci = headers.indexOf(rule.column);
  if (ci < 0) return { error: 'Column not found: ' + rule.column };
  const outputFormat = rule.outputFormat || 'YYYY-MM-DD';
  const changes = [], affectedRows = [], errorRowList = [];

  for (let r = 0; r < rows.length; r++) {
    const v = rows[r][ci].trim();
    if (v === '' || v.toLowerCase() === 'null') continue;
    const parsed = parseDate(v);
    if (parsed) {
      const formatted = formatDate(parsed, outputFormat);
      if (formatted !== v) {
        changes.push({ row: r, col: ci, before: v, after: formatted });
        rows[r][ci] = formatted;
        affectedRows.push(r);
      }
    } else {
      errorRowList.push(r);
    }
  }

  return { rows, affectedCount: affectedRows.length, affectedRows: errorRowList, changes };
}

function parseDate(str) {
  let m;
  m = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return buildDate(+m[1], +m[2], +m[3], +(m[4]||0), +(m[5]||0), +(m[6]||0));

  m = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    if (+m[1] > 12) return buildDate(y, +m[2], +m[1]);
    return buildDate(y, +m[1], +m[2]);
  }

  m = str.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return buildDate(+m[1], +m[2], +m[3]);

  m = str.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) return buildDate(+m[1], +m[2], +m[3]);

  return null;
}

function buildDate(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d, h || 0, mi || 0, s || 0);
  if (isNaN(dt.getTime())) return null;
  return dt;
}

function formatDate(d, fmt) {
  const pad = (n) => String(n).padStart(2, '0');
  return fmt
    .replace('YYYY', d.getFullYear())
    .replace('MM', pad(d.getMonth() + 1))
    .replace('DD', pad(d.getDate()))
    .replace('HH', pad(d.getHours()))
    .replace('mm', pad(d.getMinutes()))
    .replace('ss', pad(d.getSeconds()));
}

/* --- Amount Convert --- */
function ruleAmountConvert(headers, rows, rule) {
  const ci = headers.indexOf(rule.column);
  if (ci < 0) return { error: 'Column not found: ' + rule.column };
  const factor = rule.factor || 1;
  const prefix = rule.prefix || '';
  const suffix = rule.suffix || '';
  const decimals = rule.decimals != null ? rule.decimals : 2;
  const changes = [], affectedRows = [], errorRowList = [];

  for (let r = 0; r < rows.length; r++) {
    let v = rows[r][ci].trim();
    if (v === '' || v.toLowerCase() === 'null') continue;
    v = v.replace(/[¥$€£￥,，\s]/g, '');
    const num = parseFloat(v);
    if (isNaN(num)) { errorRowList.push(r); continue; }
    const converted = (num * factor).toFixed(decimals);
    const formatted = prefix + converted + suffix;
    if (formatted !== rows[r][ci]) {
      changes.push({ row: r, col: ci, before: rows[r][ci], after: formatted });
      rows[r][ci] = formatted;
      affectedRows.push(r);
    }
  }

  return { rows, affectedCount: affectedRows.length, affectedRows: errorRowList, changes };
}

/* --- Enum Map --- */
function ruleEnumMap(headers, rows, rule) {
  const ci = headers.indexOf(rule.column);
  if (ci < 0) return { error: 'Column not found: ' + rule.column };
  const mapping = rule.mapping || {};
  const changes = [], affectedRows = [];

  for (let r = 0; r < rows.length; r++) {
    const v = rows[r][ci].trim();
    if (v in mapping) {
      const newVal = mapping[v];
      changes.push({ row: r, col: ci, before: v, after: newVal });
      rows[r][ci] = newVal;
      affectedRows.push(r);
    }
  }

  return { rows, affectedCount: affectedRows.length, affectedRows, changes };
}

/* --- Cross Validate --- */
function ruleCrossValidate(headers, rows, rule, allDatasets) {
  if (!allDatasets || !allDatasets[rule.otherDataset]) {
    return { error: 'Dataset not found: ' + rule.otherDataset };
  }
  const other = allDatasets[rule.otherDataset];
  const ci = headers.indexOf(rule.thisColumn);
  if (ci < 0) return { error: 'Column not found: ' + rule.thisColumn };
  const oci = other.headers.indexOf(rule.otherColumn);
  if (oci < 0) return { error: 'Column not found in other dataset: ' + rule.otherColumn };

  const lookup = new Set();
  for (const row of other.rows) {
    const v = row[oci] ? row[oci].trim() : '';
    if (v !== '') lookup.add(v);
  }

  const errorRowList = [], changes = [];
  for (let r = 0; r < rows.length; r++) {
    const v = rows[r][ci].trim();
    if (v !== '' && !lookup.has(v)) {
      errorRowList.push(r);
      changes.push({ row: r, col: ci, value: v, detail: 'No match in ' + rule.otherDataset + '.' + rule.otherColumn });
    }
  }

  return { rows, affectedCount: errorRowList.length, affectedRows: errorRowList, changes };
}

/* --- Rename --- */
function ruleRename(headers, rows, rule) {
  const mapping = rule.mapping || {};
  const newHeaders = headers.map(h => mapping[h] || h);
  const changes = headers.filter(h => mapping[h]).map(h => ({ before: h, after: mapping[h] }));
  return { headers: newHeaders, rows, affectedCount: changes.length, affectedRows: [], changes };
}

/* --- Trim --- */
function ruleTrim(headers, rows, rule) {
  const changes = [], affectedRows = [];
  for (let r = 0; r < rows.length; r++) {
    let changed = false;
    for (let c = 0; c < rows[r].length; c++) {
      const trimmed = rows[r][c].trim();
      if (trimmed !== rows[r][c]) {
        if (changes.length < 200) changes.push({ row: r, col: c, before: rows[r][c], after: trimmed });
        rows[r][c] = trimmed;
        changed = true;
      }
    }
    if (changed) affectedRows.push(r);
  }
  return { rows, affectedCount: affectedRows.length, affectedRows, changes };
}

/* ============================================================
   CROSS VALIDATE (standalone)
   ============================================================ */
function crossValidate(datasets, rules) {
  const results = [];
  for (const rule of rules) {
    if (rule.type !== 'crossValidate') continue;
    const ds = datasets[rule.thisDataset];
    if (!ds) continue;
    const res = ruleCrossValidate(ds.headers, ds.rows.map(r => r.slice()), rule, datasets);
    results.push({ rule, ...res });
  }
  return results;
}

/* ============================================================
   COLUMN FINGERPRINT — extract fingerprint data from profiles
   ============================================================ */
function computeColumnFingerprints(headers, rows, profiles) {
  if (profiles && profiles.profiles) {
    return profiles.profiles.map((p, i) => ({
      name: p.column,
      index: i,
      detectedType: p.type,
      typeConfidence: p.typeConfidence,
      nullRate: p.nullRate,
      isEnum: p.isEnum || false,
      enumValues: p.enumValues ? p.enumValues.slice(0, 10).map(e => e.value) : null,
      sampleValues: (p.sampleValues || []).slice(0, 5),
      uniqueRatio: (p.validCount + p.dirtyCount) > 0
        ? p.uniqueCount / (p.validCount + p.dirtyCount)
        : 0
    }));
  }
  // Fallback: compute from scratch
  const profile = profileDataset(headers, rows);
  return profile.profiles.map((p, i) => ({
    name: p.column,
    index: i,
    detectedType: p.type,
    typeConfidence: p.typeConfidence,
    nullRate: p.nullRate,
    isEnum: p.isEnum || false,
    enumValues: p.enumValues ? p.enumValues.slice(0, 10).map(e => e.value) : null,
    sampleValues: (p.sampleValues || []).slice(0, 5),
    uniqueRatio: (p.validCount + p.dirtyCount) > 0
      ? p.uniqueCount / (p.validCount + p.dirtyCount)
      : 0
  }));
}
