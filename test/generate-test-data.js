#!/usr/bin/env node
/**
 * generate-test-data.js — Generates CSV test fixtures for the CSV cleaning tool.
 *
 * Usage:  node test/generate-test-data.js [--rows N] [--output DIR]
 *
 * Generates:
 *   test-large.csv            1,000,000 rows — stress test with nulls & duplicates
 *   test-malformed-quotes.csv 1,000 rows     — unclosed quotes, smart quotes, embedded newlines
 *   test-bad-rows.csv         5,000 rows     — wrong column counts, empty rows, stray delimiters
 *   test-duplicate-headers.csv  100 rows      — repeated column names
 *   test-type-drift.csv       10,000 rows    — integer→string drift, mixed date/amount formats
 */

const fs = require('fs');
const path = require('path');

// --------------- CLI args ---------------
const args = process.argv.slice(2);
let LARGE_ROWS = 1_000_000;
let OUTPUT_DIR = path.join(__dirname);

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--rows' && args[i + 1]) LARGE_ROWS = parseInt(args[++i], 10);
  if (args[i] === '--output' && args[i + 1]) OUTPUT_DIR = args[++i];
}

// --------------- Helpers ---------------
let seed = 42;
function rand() { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff; }
function randInt(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }

const FIRST_NAMES = ['张伟','李娜','王芳','刘洋','陈静','杨帆','赵磊','黄丽','周杰','吴敏',
  'Alice','Bob','Charlie','Diana','Eve','Frank','Grace','Henry','Ivy','Jack'];
const LAST_NAMES = ['Smith','Johnson','Wang','Li','Zhang','Chen','Liu','Yang','Huang','Zhao'];
const CATEGORIES = ['电子','服装','食品','家居','运动','图书','美妆','数码'];
const STATUSES = ['pending','completed','cancelled','refunded','processing'];

function randomName() { return pick(FIRST_NAMES) + ' ' + pick(LAST_NAMES); }
function randomEmail(id) { return 'user' + id + '@' + pick(['gmail.com','qq.com','163.com','outlook.com']); }
function randomPhone() { return '1' + randInt(30,99) + String(randInt(10000000,99999999)); }
function randomDate() {
  const y = randInt(2018, 2025);
  const m = randInt(1, 12);
  const d = randInt(1, 28);
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function randomAmount() { return (rand() * 10000).toFixed(2); }
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// --------------- 1. test-large.csv ---------------
async function generateLarge() {
  const file = path.join(OUTPUT_DIR, 'test-large.csv');
  const ws = fs.createWriteStream(file, { encoding: 'utf8' });
  console.log(`Generating ${file} (${LARGE_ROWS.toLocaleString()} rows)...`);

  ws.write('id,name,email,phone,date,amount,category,status,notes,score\n');

  // Pre-generate some rows for duplication (~2%)
  const dupPool = [];
  for (let i = 0; i < 200; i++) {
    const id = i + 1;
    dupPool.push(`${id},${csvEscape(randomName())},${randomEmail(id)},${randomPhone()},${randomDate()},${randomAmount()},${pick(CATEGORIES)},${pick(STATUSES)},${csvEscape('备注' + id)},${randInt(0,100)}`);
  }

  let written = 0;
  for (let i = 0; i < LARGE_ROWS; i++) {
    let line;
    // ~2% duplicate rows
    if (rand() < 0.02) {
      line = pick(dupPool);
    } else {
      const id = i + 1;
      const name = rand() < 0.05 ? '' : randomName();       // 5% null name
      const email = rand() < 0.05 ? '' : randomEmail(id);    // 5% null email
      const phone = rand() < 0.05 ? 'N/A' : randomPhone();   // 5% null phone
      const date = rand() < 0.05 ? '' : randomDate();
      const amount = rand() < 0.05 ? 'null' : randomAmount();
      const cat = pick(CATEGORIES);
      const status = pick(STATUSES);
      const notes = rand() < 0.03 ? '  有空格  ' : ('note_' + id); // 3% dirty whitespace
      const score = rand() < 0.05 ? '-' : String(randInt(0, 100));
      line = `${id},${csvEscape(name)},${email},${phone},${date},${amount},${cat},${status},${csvEscape(notes)},${score}`;
    }

    const ok = ws.write(line + '\n');
    written++;
    if (!ok) {
      await new Promise(resolve => ws.once('drain', resolve));
    }
    if (written % 200000 === 0) process.stdout.write(`  ${(written / LARGE_ROWS * 100).toFixed(0)}%\r`);
  }

  ws.end();
  return new Promise(resolve => ws.on('finish', () => {
    console.log(`  Done: ${written.toLocaleString()} rows`);
    resolve();
  }));
}

// --------------- 2. test-malformed-quotes.csv ---------------
function generateMalformedQuotes() {
  const file = path.join(OUTPUT_DIR, 'test-malformed-quotes.csv');
  console.log(`Generating ${file}...`);

  const lines = ['id,name,description,value'];

  for (let i = 1; i <= 1000; i++) {
    let desc, name = 'item_' + i, value = randInt(1, 999);
    const scenario = i % 10;

    switch (scenario) {
      case 0: // Normal quoted field
        desc = '"This is a normal, quoted field"';
        break;
      case 1: // Unclosed opening quote — parser should recover
        desc = '"This quote is never closed';
        break;
      case 2: // Smart quotes (correct pair)
        desc = '\u201c' + 'Smart quoted text' + '\u201d';
        break;
      case 3: // Smart quotes (mismatched — only left quote)
        desc = '\u201c' + 'Only left smart quote';
        break;
      case 4: // Smart quotes (only right quote as opener)
        desc = '\u201d' + 'Right smart quote as opener' + '\u201c';
        break;
      case 5: // Embedded newline inside valid quotes
        desc = '"Line one\nLine two\nLine three"';
        break;
      case 6: // Escaped quotes inside quoted field
        desc = '"He said ""hello"" to them"';
        break;
      case 7: // Quote in middle of unquoted field
        desc = 'mid"quote"here';
        break;
      case 8: // Empty quoted field
        desc = '""';
        break;
      case 9: // Embedded comma and quote
        desc = '"value, with ""comma"" and quote"';
        break;
    }
    lines.push(`${i},${name},${desc},${value}`);
  }

  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  console.log(`  Done: 1,000 rows`);
}

// --------------- 3. test-bad-rows.csv ---------------
function generateBadRows() {
  const file = path.join(OUTPUT_DIR, 'test-bad-rows.csv');
  console.log(`Generating ${file}...`);

  const lines = ['id,name,age,city,score'];

  for (let i = 1; i <= 5000; i++) {
    const scenario = i % 12;
    switch (scenario) {
      case 0: // Normal row
        lines.push(`${i},${randomName()},${randInt(18,80)},${pick(['北京','上海','广州','深圳'])},${randInt(0,100)}`);
        break;
      case 1: // Too few columns (only 3)
        lines.push(`${i},${randomName()},${randInt(18,80)}`);
        break;
      case 2: // Too many columns (7)
        lines.push(`${i},${randomName()},${randInt(18,80)},北京,${randInt(0,100)},extra1,extra2`);
        break;
      case 3: // Empty row
        lines.push('');
        break;
      case 4: // Row with only commas
        lines.push(',,,,');
        break;
      case 5: // Unquoted comma in field
        lines.push(`${i},张,伟,${randInt(18,80)},北京`);
        break;
      case 6: // Tab character in field
        lines.push(`${i},name\twith\ttabs,${randInt(18,80)},上海,${randInt(0,100)}`);
        break;
      case 7: // Control characters
        lines.push(`${i},\x01bad\x02chars\x03,${randInt(18,80)},广州,${randInt(0,100)}`);
        break;
      case 8: // Very long field
        lines.push(`${i},${'A'.repeat(500)},${randInt(18,80)},深圳,${randInt(0,100)}`);
        break;
      case 9: // Unicode edge cases
        lines.push(`${i},名前\u200B零幅,${randInt(18,80)},東京,${randInt(0,100)}`);
        break;
      case 10: // Single column
        lines.push(`${i}`);
        break;
      case 11: // Normal row (to keep ratio balanced)
        lines.push(`${i},${randomName()},${randInt(18,80)},${pick(['成都','杭州','武汉','南京'])},${randInt(0,100)}`);
        break;
    }
  }

  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  console.log(`  Done: 5,000 rows`);
}

// --------------- 4. test-duplicate-headers.csv ---------------
function generateDuplicateHeaders() {
  const file = path.join(OUTPUT_DIR, 'test-duplicate-headers.csv');
  console.log(`Generating ${file}...`);

  // Intentionally duplicate "name" and "value" columns
  const lines = ['id,name,name,value,category,value,notes'];

  for (let i = 1; i <= 100; i++) {
    const name1 = randomName();
    const name2 = pick(FIRST_NAMES);
    const val1 = randInt(1, 1000);
    const val2 = randomAmount();
    const cat = pick(CATEGORIES);
    const notes = 'note_' + i;
    lines.push(`${i},${csvEscape(name1)},${csvEscape(name2)},${val1},${cat},${val2},${notes}`);
  }

  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  console.log(`  Done: 100 rows with duplicate column names [name, name, value, value]`);
}

// --------------- 5. test-type-drift.csv ---------------
function generateTypeDrift() {
  const file = path.join(OUTPUT_DIR, 'test-type-drift.csv');
  console.log(`Generating ${file}...`);

  const lines = ['id,code,date,amount,flag'];

  for (let i = 1; i <= 10000; i++) {
    // code: first 5000 rows are pure integers, then starts mixing in strings
    let code;
    if (i <= 5000) {
      code = String(randInt(10000, 99999));
    } else if (i <= 7000) {
      // Transition zone: ~50% integers, ~50% strings
      code = rand() < 0.5 ? String(randInt(10000, 99999)) : 'SKU-' + randInt(100, 999);
    } else {
      // Fully string
      code = 'SKU-' + randInt(100, 999) + '-' + pick(['A','B','C','X']);
    }

    // date: mixed formats throughout
    let date;
    const dateFmt = i % 5;
    const y = randInt(2020, 2025), mo = randInt(1,12), d = randInt(1,28);
    switch (dateFmt) {
      case 0: date = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`; break;        // YYYY-MM-DD
      case 1: date = `${String(d).padStart(2,'0')}/${String(mo).padStart(2,'0')}/${y}`; break;         // DD/MM/YYYY
      case 2: date = `${y}${String(mo).padStart(2,'0')}${String(d).padStart(2,'0')}`; break;           // YYYYMMDD
      case 3: date = `${y}年${mo}月${d}日`; break;                                                     // YYYY年M月D日
      case 4: date = `${String(mo).padStart(2,'0')}/${String(d).padStart(2,'0')}/${y % 100}`; break;   // MM/DD/YY
    }

    // amount: mixed currency formats
    let amount;
    const amtFmt = i % 4;
    const rawAmt = (rand() * 10000).toFixed(2);
    switch (amtFmt) {
      case 0: amount = rawAmt; break;                     // plain
      case 1: amount = '¥' + rawAmt; break;               // yen/yuan prefix
      case 2: amount = '$' + rawAmt; break;                // dollar prefix
      case 3: amount = rawAmt.replace(/\B(?=(\d{3})+(?!\d))/g, ','); break; // with commas
    }

    // flag: drifts from boolean to string
    let flag;
    if (i <= 4000) {
      flag = rand() < 0.5 ? 'true' : 'false';
    } else if (i <= 7000) {
      flag = pick(['true', 'false', 'yes', 'no', '1', '0']);
    } else {
      flag = pick(['active', 'inactive', 'pending', 'true', 'false']);
    }

    lines.push(`${i},${code},${date},${csvEscape(amount)},${flag}`);
  }

  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  console.log(`  Done: 10,000 rows with type drift`);
}

// --------------- Main ---------------
async function main() {
  console.log(`Output directory: ${OUTPUT_DIR}\n`);
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  await generateLarge();
  generateMalformedQuotes();
  generateBadRows();
  generateDuplicateHeaders();
  generateTypeDrift();

  console.log('\nAll test files generated successfully.');
}

main().catch(err => { console.error(err); process.exit(1); });
