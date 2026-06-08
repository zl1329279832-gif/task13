/* ============================================================
   csv-worker.js  –  Web Worker for CSV parsing & data cleaning
   All heavy computation runs here to keep UI responsive.
   ============================================================ */

"use strict";

/* ---------- message router ---------- */
self.onmessage = function (e) {
  const { id, action, payload } = e.data;
  try {
    let result;
    switch (action) {
      case "parse":          result = parseCSV(payload);          break;
      case "inferTypes":     result = inferTypes(payload);        break;
      case "detectIssues":   result = detectIssues(payload);      break;
      case "executeRules":   result = executeRules(payload);      break;
      case "qualityScore":   result = qualityScore(payload);      break;
      case "exportCSV":      result = exportCSV(payload);         break;
      case "crossValidate":  result = crossValidate(payload);     break;
      default: throw new Error("Unknown action: " + action);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};

/* ================================================================
   1. CSV Parser  –  handles quoted fields, newlines inside quotes
   ================================================================ */
function parseCSV(payload) {
  const { text, delimiter } = payload;
  const delim = delimiter || ",";
  const rows = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const row = [];
    while (i < len) {
      let value = "";
      if (text[i] === '"') {
        // quoted field
        i++;
        while (i < len) {
          if (text[i] === '"') {
            if (i + 1 < len && text[i + 1] === '"') {
              value += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            value += text[i++];
          }
        }
      } else {
        while (i < len && text[i] !== delim && text[i] !== "\r" && text[i] !== "\n") {
          value += text[i++];
        }
      }
      row.push(value);
      if (i < len && text[i] === delim) { i++; continue; }
      break;
    }
    // skip line ending
    if (i < len && text[i] === "\r") i++;
    if (i < len && text[i] === "\n") i++;
    if (row.length === 1 && row[0] === "" && i >= len) break; // trailing newline
    rows.push(row);
  }

  if (rows.length === 0) return { headers: [], data: [] };
  const headers = rows[0];
  const data = rows.slice(1);
  return { headers, data };
}

/* ================================================================
   2. Type Inference
   ================================================================ */
const DATE_PATTERNS = [
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/,                              // 2024-01-15
  /^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/,                              // 01/15/2024
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}[T ]\d{1,2}:\d{2}(:\d{2})?$/,   // datetime
  /^\d{4}年\d{1,2}月\d{1,2}日$/,                                 // 中文日期
  /^\d{8}$/,                                                      // 20240115
];

const AMOUNT_PATTERNS = [
  /^[¥$€£]\s?[\d,]+\.?\d*$/,             // ¥1,234.56
  /^[\d,]+\.?\d*\s?[¥$€£]$/,             // 1,234.56¥
  /^-?[\d,]+\.\d{2}$/,                   // 1234.56  (two decimal places)
  /^[\d,]+\.?\d*\s?(元|万|万元|USD|CNY|EUR|GBP)$/i,
];

function inferColumnType(values) {
  let nonEmpty = 0, nullCount = 0;
  let dateCount = 0, amountCount = 0, intCount = 0, floatCount = 0;
  const uniq = new Set();
  const sample = values.length > 2000 ? sampleArray(values, 2000) : values;

  for (const raw of sample) {
    const v = raw.trim();
    if (v === "" || v.toLowerCase() === "null" || v.toLowerCase() === "na" || v === "-" || v.toLowerCase() === "n/a") {
      nullCount++;
      continue;
    }
    nonEmpty++;
    uniq.add(v);
    if (DATE_PATTERNS.some(p => p.test(v))) { dateCount++; continue; }
    if (AMOUNT_PATTERNS.some(p => p.test(v))) { amountCount++; continue; }
    const num = Number(v.replace(/,/g, ""));
    if (!isNaN(num) && v !== "") {
      if (Number.isInteger(num)) intCount++;
      else floatCount++;
    }
  }

  const total = nonEmpty || 1;
  const nullRate = nullCount / (sample.length || 1);

  if (dateCount / total > 0.8)   return { type: "date",   nullRate, uniqueCount: uniq.size };
  if (amountCount / total > 0.7) return { type: "amount", nullRate, uniqueCount: uniq.size };
  if ((intCount + floatCount) / total > 0.8) {
    return { type: floatCount > intCount ? "float" : "integer", nullRate, uniqueCount: uniq.size };
  }
  // Enum detection: low cardinality relative to count
  if (uniq.size > 0 && uniq.size <= Math.max(20, total * 0.05)) {
    return { type: "enum", nullRate, uniqueCount: uniq.size, enumValues: [...uniq].slice(0, 50) };
  }
  return { type: "string", nullRate, uniqueCount: uniq.size };
}

function inferTypes(payload) {
  const { headers, data } = payload;
  const columns = {};
  for (let c = 0; c < headers.length; c++) {
    const col = headers[c];
    const vals = data.map(r => (r[c] !== undefined ? r[c] : ""));
    const info = inferColumnType(vals);
    // Primary-key detection: all unique, no nulls
    info.isPrimaryKey = info.uniqueCount === data.length && info.nullRate === 0 && data.length > 0;
    columns[col] = info;
  }
  return columns;
}

/* ================================================================
   3. Issue Detection
   ================================================================ */
function detectIssues(payload) {
  const { headers, data, columnTypes } = payload;
  const issues = { nullCells: [], duplicateRows: [], dirtyData: [] };

  // null cells
  for (let r = 0; r < data.length; r++) {
    for (let c = 0; c < headers.length; c++) {
      const v = (data[r][c] || "").trim();
      if (v === "" || v.toLowerCase() === "null" || v.toLowerCase() === "na" || v === "-" || v.toLowerCase() === "n/a") {
        issues.nullCells.push({ row: r, col: c, value: data[r][c] });
      }
    }
  }

  // duplicate rows
  const seen = new Map();
  for (let r = 0; r < data.length; r++) {
    const key = data[r].join("\x00");
    if (seen.has(key)) {
      issues.duplicateRows.push({ row: r, firstSeen: seen.get(key) });
    } else {
      seen.set(key, r);
    }
  }

  // dirty data  – values that don't match inferred type
  if (columnTypes) {
    for (let c = 0; c < headers.length; c++) {
      const ct = columnTypes[headers[c]];
      if (!ct) continue;
      for (let r = 0; r < data.length; r++) {
        const v = (data[r][c] || "").trim();
        if (v === "" || v.toLowerCase() === "null" || v.toLowerCase() === "na" || v === "-" || v.toLowerCase() === "n/a") continue;
        if (ct.type === "date" && !DATE_PATTERNS.some(p => p.test(v))) {
          issues.dirtyData.push({ row: r, col: c, value: v, expected: "date" });
        } else if (ct.type === "amount" && !AMOUNT_PATTERNS.some(p => p.test(v))) {
          const num = Number(v.replace(/,/g, ""));
          if (isNaN(num)) issues.dirtyData.push({ row: r, col: c, value: v, expected: "amount" });
        } else if ((ct.type === "integer" || ct.type === "float") && isNaN(Number(v.replace(/,/g, "")))) {
          issues.dirtyData.push({ row: r, col: c, value: v, expected: ct.type });
        }
      }
    }
  }

  return issues;
}

/* ================================================================
   4. Rule Execution Engine
   ================================================================ */
function executeRules(payload) {
  const { headers, data, rules } = payload;
  let current = data.map(r => [...r]);
  let curHeaders = [...headers];
  const log = [];
  const affectedRows = new Set();
  const errorRows = [];

  // Sort rules by order
  const sorted = [...rules].sort((a, b) => (a.order || 0) - (b.order || 0));

  for (const rule of sorted) {
    if (!rule.enabled) continue;
    const before = current.length;
    const ruleLog = { ruleId: rule.id, type: rule.type, affected: 0, errors: [] };

    try {
      switch (rule.type) {
        case "dedup": {
          const cols = rule.config.columns || [];
          const keyFn = cols.length
            ? (r) => cols.map(c => r[curHeaders.indexOf(c)] || "").join("\x00")
            : (r) => r.join("\x00");
          const seen = new Set();
          const kept = [];
          for (let i = 0; i < current.length; i++) {
            const k = keyFn(current[i]);
            if (seen.has(k)) { affectedRows.add(i); ruleLog.affected++; }
            else { seen.add(k); kept.push(current[i]); }
          }
          current = kept;
          break;
        }

        case "fillNull": {
          const ci = curHeaders.indexOf(rule.config.column);
          if (ci === -1) break;
          const strategy = rule.config.strategy || "value";
          let fillVal = rule.config.value || "";
          if (strategy === "mean" || strategy === "median") {
            const nums = current.map(r => parseFloat((r[ci] || "").replace(/,/g, ""))).filter(n => !isNaN(n));
            if (strategy === "mean") fillVal = String(nums.reduce((a, b) => a + b, 0) / (nums.length || 1));
            else {
              nums.sort((a, b) => a - b);
              fillVal = String(nums[Math.floor(nums.length / 2)] || 0);
            }
          } else if (strategy === "mode") {
            const freq = {};
            current.forEach(r => { const v = (r[ci] || "").trim(); if (v && v.toLowerCase() !== "null" && v.toLowerCase() !== "na") { freq[v] = (freq[v] || 0) + 1; } });
            fillVal = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
          } else if (strategy === "forward") {
            let last = "";
            for (let i = 0; i < current.length; i++) {
              const v = (current[i][ci] || "").trim();
              if (isNullLike(v)) { current[i][ci] = last; affectedRows.add(i); ruleLog.affected++; }
              else last = current[i][ci];
            }
            break;
          }
          for (let i = 0; i < current.length; i++) {
            const v = (current[i][ci] || "").trim();
            if (isNullLike(v)) { current[i][ci] = fillVal; affectedRows.add(i); ruleLog.affected++; }
          }
          break;
        }

        case "splitField": {
          const ci = curHeaders.indexOf(rule.config.column);
          if (ci === -1) break;
          const sep = rule.config.separator || ",";
          const names = rule.config.newColumns || [rule.config.column + "_1", rule.config.column + "_2"];
          // Remove original, insert new columns
          const newHeaders = [...curHeaders.slice(0, ci), ...names, ...curHeaders.slice(ci + 1)];
          const newData = current.map((r, ri) => {
            const parts = (r[ci] || "").split(sep);
            const cells = names.map((_, i) => (parts[i] || "").trim());
            affectedRows.add(ri);
            ruleLog.affected++;
            return [...r.slice(0, ci), ...cells, ...r.slice(ci + 1)];
          });
          curHeaders = newHeaders;
          current = newData;
          break;
        }

        case "dateStandardize": {
          const ci = curHeaders.indexOf(rule.config.column);
          if (ci === -1) break;
          const fmt = rule.config.format || "YYYY-MM-DD";
          for (let i = 0; i < current.length; i++) {
            const v = (current[i][ci] || "").trim();
            if (isNullLike(v)) continue;
            const d = parseAnyDate(v);
            if (d) {
              current[i][ci] = formatDate(d, fmt);
              affectedRows.add(i);
              ruleLog.affected++;
            } else {
              ruleLog.errors.push({ row: i, col: ci, value: v, msg: "Cannot parse date" });
              errorRows.push({ row: i, col: ci, value: v, rule: rule.id });
            }
          }
          break;
        }

        case "amountConvert": {
          const ci = curHeaders.indexOf(rule.config.column);
          if (ci === -1) break;
          const rate = rule.config.rate || 1;
          const targetUnit = rule.config.targetUnit || "";
          for (let i = 0; i < current.length; i++) {
            const v = (current[i][ci] || "").trim();
            if (isNullLike(v)) continue;
            const num = parseAmount(v);
            if (num !== null) {
              const converted = (num * rate).toFixed(2);
              current[i][ci] = targetUnit ? converted + " " + targetUnit : converted;
              affectedRows.add(i);
              ruleLog.affected++;
            } else {
              ruleLog.errors.push({ row: i, col: ci, value: v, msg: "Cannot parse amount" });
              errorRows.push({ row: i, col: ci, value: v, rule: rule.id });
            }
          }
          break;
        }

        case "enumMap": {
          const ci = curHeaders.indexOf(rule.config.column);
          if (ci === -1) break;
          const mapping = rule.config.mapping || {};
          for (let i = 0; i < current.length; i++) {
            const v = (current[i][ci] || "").trim();
            if (v in mapping) { current[i][ci] = mapping[v]; affectedRows.add(i); ruleLog.affected++; }
          }
          break;
        }

        case "rename": {
          const idx = curHeaders.indexOf(rule.config.oldName);
          if (idx !== -1) { curHeaders[idx] = rule.config.newName; ruleLog.affected = current.length; }
          break;
        }

        default:
          ruleLog.errors.push({ msg: "Unknown rule type: " + rule.type });
      }
    } catch (err) {
      ruleLog.errors.push({ msg: err.message });
    }

    log.push(ruleLog);
  }

  return { headers: curHeaders, data: current, log, errorRows, totalAffected: affectedRows.size };
}

/* ================================================================
   5. Cross-Table Validation
   ================================================================ */
function crossValidate(payload) {
  const { sourceHeaders, sourceData, sourceCol, targetHeaders, targetData, targetCol } = payload;
  const si = sourceHeaders.indexOf(sourceCol);
  const ti = targetHeaders.indexOf(targetCol);
  if (si === -1 || ti === -1) return { orphanRows: [], msg: "Column not found" };

  const targetSet = new Set(targetData.map(r => (r[ti] || "").trim()));
  const orphanRows = [];
  for (let i = 0; i < sourceData.length; i++) {
    const v = (sourceData[i][si] || "").trim();
    if (v && !targetSet.has(v)) orphanRows.push({ row: i, value: v });
  }
  return { orphanRows };
}

/* ================================================================
   6. Quality Score
   ================================================================ */
function qualityScore(payload) {
  const { headers, data, columnTypes } = payload;
  const total = data.length * headers.length || 1;
  let nulls = 0, dirtyCount = 0, dupes = 0;

  // nulls
  for (let r = 0; r < data.length; r++) {
    for (let c = 0; c < headers.length; c++) {
      if (isNullLike((data[r][c] || "").trim())) nulls++;
    }
  }

  // duplicates
  const seen = new Set();
  for (const row of data) {
    const k = row.join("\x00");
    if (seen.has(k)) dupes++;
    else seen.add(k);
  }

  // dirty
  if (columnTypes) {
    for (let c = 0; c < headers.length; c++) {
      const ct = columnTypes[headers[c]];
      if (!ct) continue;
      for (let r = 0; r < data.length; r++) {
        const v = (data[r][c] || "").trim();
        if (isNullLike(v)) continue;
        if (ct.type === "date" && !DATE_PATTERNS.some(p => p.test(v))) dirtyCount++;
        else if ((ct.type === "integer" || ct.type === "float") && isNaN(Number(v.replace(/,/g, "")))) dirtyCount++;
      }
    }
  }

  const completeness = 1 - nulls / total;
  const uniqueness = 1 - dupes / (data.length || 1);
  const validity = 1 - dirtyCount / total;
  const overall = (completeness * 0.35 + uniqueness * 0.30 + validity * 0.35);

  return {
    completeness: +(completeness * 100).toFixed(1),
    uniqueness: +(uniqueness * 100).toFixed(1),
    validity: +(validity * 100).toFixed(1),
    overall: +(overall * 100).toFixed(1),
    stats: { totalCells: total, nulls, dupes, dirtyCount, rows: data.length, cols: headers.length }
  };
}

/* ================================================================
   7. Export CSV
   ================================================================ */
function exportCSV(payload) {
  const { headers, data } = payload;
  const escape = v => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n") ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(escape).join(",")];
  for (const row of data) {
    lines.push(row.map(escape).join(","));
  }
  return lines.join("\n");
}

/* ================================================================
   Helpers
   ================================================================ */
function isNullLike(v) {
  return v === "" || v.toLowerCase() === "null" || v.toLowerCase() === "na" || v === "-" || v.toLowerCase() === "n/a" || v.toLowerCase() === "none";
}

function parseAmount(v) {
  const cleaned = v.replace(/[¥$€£,\s]/g, "").replace(/(元|万元?|USD|CNY|EUR|GBP)/gi, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  if (/万/.test(v)) return num * 10000;
  return num;
}

function parseAnyDate(v) {
  // 20240115
  if (/^\d{8}$/.test(v)) {
    return new Date(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8));
  }
  // 2024年1月15日
  const cn = v.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (cn) return new Date(+cn[1], +cn[2] - 1, +cn[3]);
  // Try standard parse
  const t = Date.parse(v.replace(/\//g, "-"));
  if (!isNaN(t)) return new Date(t);
  // dd/mm/yyyy or mm/dd/yyyy
  const parts = v.split(/[-/]/);
  if (parts.length === 3) {
    const [a, b, c] = parts.map(Number);
    if (a > 31) return new Date(a, b - 1, c);
    if (c > 31) return new Date(c, a - 1, b); // mm/dd/yyyy
  }
  return null;
}

function formatDate(d, fmt) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  switch (fmt) {
    case "YYYY-MM-DD": return `${y}-${m}-${day}`;
    case "YYYY/MM/DD": return `${y}/${m}/${day}`;
    case "DD/MM/YYYY": return `${day}/${m}/${y}`;
    case "MM/DD/YYYY": return `${m}/${day}/${y}`;
    case "YYYYMMDD":   return `${y}${m}${day}`;
    default: return `${y}-${m}-${day}`;
  }
}

function sampleArray(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const result = [];
  for (let i = 0; i < n; i++) result.push(arr[Math.floor(i * step)]);
  return result;
}
