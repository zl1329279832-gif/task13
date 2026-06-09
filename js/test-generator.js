/* test-generator.js — CSV test data generators for validation */

/* --- Helpers --- */
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randChoice(arr) { return arr[randInt(0, arr.length - 1)]; }

function randName() {
  const first = ['张', '李', '王', '赵', '刘', '陈', '杨', '黄', '周', '吴',
    'John', 'Jane', 'Bob', 'Alice', 'Tom', 'Mary', 'David', 'Sarah'];
  const last = ['伟', '芳', '敏', '强', '磊', '洋', '艳', '军', '丽', '超',
    'Smith', 'Johnson', 'Brown', 'Wilson', 'Taylor', 'Clark'];
  return randChoice(first) + randChoice(last);
}

function randEmail(name) {
  const domains = ['gmail.com', 'qq.com', '163.com', 'outlook.com', 'company.cn'];
  const clean = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '').toLowerCase();
  return (clean || 'user' + randInt(1, 999)) + randInt(1, 99) + '@' + randChoice(domains);
}

function randDate() {
  const formats = [
    () => { const y = randInt(2020, 2025); const m = String(randInt(1, 12)).padStart(2, '0'); const d = String(randInt(1, 28)).padStart(2, '0'); return `${y}-${m}-${d}`; },
    () => { const y = randInt(2020, 2025); const m = String(randInt(1, 12)).padStart(2, '0'); const d = String(randInt(1, 28)).padStart(2, '0'); return `${y}/${m}/${d}`; },
    () => `${randInt(1, 12)}/${randInt(1, 28)}/${randInt(2020, 2025)}`,
    () => `${randInt(2020, 2025)}年${randInt(1, 12)}月${randInt(1, 28)}日`,
  ];
  return randChoice(formats)();
}

function randAmount() { return (Math.random() * 10000).toFixed(2); }

function randCategory() {
  return randChoice(['电子产品', '食品', '服装', '家居', '办公', '运动', '图书', '美妆']);
}

function randStatus() { return randChoice(['正常', '待审核', '已取消', '已完成', '异常']); }

function downloadCSV(filename, content) {
  const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function log(msg) {
  const el = document.getElementById('output');
  el.style.display = 'block';
  el.textContent += msg + '\n';
}

function clearLog() {
  const el = document.getElementById('output');
  el.style.display = 'none';
  el.textContent = '';
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function setMeta(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/* --- Dispatcher --- */
function runGenerator(type) {
  clearLog();
  const t0 = performance.now();
  let filename, content, rowCount;

  switch (type) {
    case 'large': {
      rowCount = parseInt(document.getElementById('largeRows').value) || 1000000;
      log(`生成 ${rowCount.toLocaleString()} 行基准数据...`);
      content = generateLarge(rowCount);
      filename = 'test_large_' + rowCount + '.csv';
      break;
    }
    case 'malformed': {
      log('生成异常格式数据...');
      content = generateMalformed();
      rowCount = 15;
      filename = 'test_malformed.csv';
      break;
    }
    case 'dupCols': {
      rowCount = parseInt(document.getElementById('dupColRows').value) || 5;
      log(`生成 ${rowCount} 行重复列名数据...`);
      content = generateDuplicateCols(rowCount);
      filename = 'test_duplicate_columns.csv';
      break;
    }
    case 'drift': {
      rowCount = parseInt(document.getElementById('driftRows').value) || 10000;
      log(`生成 ${rowCount.toLocaleString()} 行类型漂移数据...`);
      content = generateTypeDrift(rowCount);
      filename = 'test_type_drift.csv';
      break;
    }
    case 'nulls': {
      rowCount = parseInt(document.getElementById('nullRows').value) || 200;
      log(`生成 ${rowCount} 行空值变体数据...`);
      content = generateNulls(rowCount);
      filename = 'test_null_variants.csv';
      break;
    }
    case 'dirty': {
      rowCount = parseInt(document.getElementById('dirtyRows').value) || 500;
      log(`生成 ${rowCount} 行脏数据...`);
      content = generateDirty(rowCount);
      filename = 'test_dirty_data.csv';
      break;
    }
    case 'sink': {
      rowCount = parseInt(document.getElementById('sinkRows').value) || 50000;
      log(`生成 ${rowCount.toLocaleString()} 行综合压力数据...`);
      content = generateKitchenSink(rowCount);
      filename = 'test_kitchen_sink.csv';
      break;
    }
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
  const size = new Blob([content]).size;
  log(`完成! ${rowCount.toLocaleString()} 行, ${fmtSize(size)}, 耗时 ${elapsed}s`);

  const metaId = type === 'large' ? 'largeMeta'
    : type === 'dupCols' ? 'dupColsMeta'
    : type === 'drift' ? 'driftMeta'
    : type === 'nulls' ? 'nullsMeta'
    : type === 'dirty' ? 'dirtyMeta'
    : type === 'sink' ? 'sinkMeta'
    : type === 'malformed' ? 'malformedMeta'
    : null;
  if (metaId) setMeta(metaId, `${rowCount.toLocaleString()} 行 | ${fmtSize(size)} | ${elapsed}s`);

  downloadCSV(filename, content);
}

/* ============================================================
   Generator 1: Large clean CSV
   ============================================================ */
function generateLarge(n) {
  const lines = ['id,name,email,amount,date,category,status'];
  for (let i = 1; i <= n; i++) {
    const name = randName();
    lines.push([
      i,
      name,
      randEmail(name),
      randAmount(),
      randDate(),
      randCategory(),
      randStatus()
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

/* ============================================================
   Generator 2: Malformed CSV (hand-crafted bad rows)
   ============================================================ */
function generateMalformed() {
  // 15 carefully crafted bad rows
  const lines = [
    'id,name,description,amount,date',
    // Row 1: Normal
    '1,张三,正常数据,100.50,2024-01-15',
    // Row 2: Smart quotes (LEFT open, RIGHT close)
    '2,\u201c李四\u201d,包含智能引号的描述,200.00,2024-02-20',
    // Row 3: Mixed quotes (straight open, smart close attempt)
    '3,"王五\u201d,混合引号风格,300.00,2024-03-10',
    // Row 4: Unclosed quote (should trigger error recovery)
    '4,"赵六,这个引号没有关闭,400.00,2024-04-05',
    // Row 5: Extra fields (too many columns)
    '5,孙七,额外字段,500.00,2024-05-12,EXTRA1,EXTRA2',
    // Row 6: Missing fields (too few columns)
    '6,周八',
    // Row 7: Control characters in fields
    '7,吴九,包含\x01控制\x0B字符\x0C,700.00,2024-07-01',
    // Row 8: Embedded newlines in quoted field
    '8,"郑十",\"多行\n描述\n字段\",800.00,2024-08-15',
    // Row 9: Tab characters mixed with commas
    '9,\t陈十一\t,制表符混入,900.00,2024-09-20',
    // Row 10: Smart quotes in unquoted field
    '10,\u201c黄十二\u201d,未加引号的智能引号,1000.00,2024-10-25',
    // Row 11: Escaped quotes
    '11,"林""十三""",包含转义引号,1100.00,2024-11-30',
    // Row 12: Empty row (just newline)
    '',
    // Row 13: Only delimiters
    ',,,,',
    // Row 14: Junk after closing quote
    '14,"何十四"junk,关闭引号后有垃圾,1400.00,2024-12-01',
    // Row 15: Very long field
    '15,' + 'X'.repeat(5000) + ',超长字段测试,1500.00,2024-12-31',
  ];
  return lines.join('\n') + '\n';
}

/* ============================================================
   Generator 3: Duplicate column names
   ============================================================ */
function generateDuplicateCols(n) {
  // Headers with duplicates: name appears twice, amount appears twice
  const lines = ['id,name,amount,name,category,amount,status'];
  for (let i = 1; i <= n; i++) {
    lines.push([
      i,
      randName(),
      randAmount(),
      randName(),       // duplicate 'name' column
      randCategory(),
      (Math.random() * 5000).toFixed(2),  // duplicate 'amount' column
      randStatus()
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

/* ============================================================
   Generator 4: Type drift
   ============================================================ */
function generateTypeDrift(n) {
  const lines = ['id,value,amount,label'];
  const phase1End = Math.floor(n * 0.3);   // integers
  const phase2End = Math.floor(n * 0.7);   // floats

  for (let i = 1; i <= n; i++) {
    let value, amount;

    if (i <= phase1End) {
      // Phase 1: integers
      value = randInt(1, 10000);
      amount = randInt(100, 9999);
    } else if (i <= phase2End) {
      // Phase 2: floats
      value = (Math.random() * 10000).toFixed(randInt(1, 4));
      amount = (Math.random() * 9999).toFixed(2);
    } else {
      // Phase 3: strings (mixed with occasional numbers)
      const r = Math.random();
      if (r < 0.3) value = randInt(1, 10000);
      else if (r < 0.5) value = (Math.random() * 10000).toFixed(2);
      else value = randChoice(['N/A', 'unknown', 'pending', 'error', 'null', '--', 'none']);

      const r2 = Math.random();
      if (r2 < 0.2) amount = randInt(100, 9999);
      else if (r2 < 0.4) amount = (Math.random() * 9999).toFixed(2);
      else amount = randChoice(['¥' + randInt(1, 999), '$' + (Math.random() * 100).toFixed(2), 'N/A', '--']);
    }

    const label = i <= phase1End ? 'phase1_int'
      : i <= phase2End ? 'phase2_float'
      : 'phase3_string';

    lines.push([i, value, amount, label].join(','));
  }
  return lines.join('\n') + '\n';
}

/* ============================================================
   Generator 5: Null variants
   ============================================================ */
function generateNulls(n) {
  const nullVariants = ['', 'NULL', 'null', 'NA', 'N/A', 'n/a', '-', '  ', 'nil', 'None', 'NaN'];
  const lines = ['id,field_a,field_b,field_c,notes'];

  for (let i = 1; i <= n; i++) {
    // Each row has 1-3 null fields and some non-null fields
    const row = [i];
    for (let c = 0; c < 3; c++) {
      // 50% chance of null variant, 50% chance of real value
      if (Math.random() < 0.5) {
        row.push(nullVariants[(i + c) % nullVariants.length]);
      } else {
        row.push(c === 0 ? randName() : c === 1 ? randAmount() : randDate());
      }
    }
    row.push('Row ' + i + ' notes');
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

/* ============================================================
   Generator 6: Dirty data
   ============================================================ */
function generateDirty(n) {
  const lines = ['id,name,amount,date,category'];
  const dirtyPrefixes = ['  ', '\t', '   ', '\t\t', ' \t '];
  const dirtySuffixes = ['  ', '\t', '   ', '\x01', '\x0B', '\x0C', ' \t'];
  const controlChars = ['\x01', '\x02', '\x03', '\x0B', '\x0C', '\x0E', '\x1F'];

  for (let i = 1; i <= n; i++) {
    const prefix = randChoice(dirtyPrefixes);
    const suffix = randChoice(dirtySuffixes);

    const name = prefix + randName() + suffix;
    let amount = String(randAmount());
    let date = randDate();
    let category = randCategory();

    // Inject control characters into some fields
    if (i % 5 === 0) {
      const cc = randChoice(controlChars);
      const pos = randInt(1, amount.length - 1);
      amount = amount.slice(0, pos) + cc + amount.slice(pos);
    }
    if (i % 7 === 0) {
      const cc = randChoice(controlChars);
      date = cc + date;
    }
    if (i % 3 === 0) {
      category = prefix + category + suffix;
    }

    lines.push([i, name, amount, date, category].join(','));
  }
  return lines.join('\n') + '\n';
}

/* ============================================================
   Generator 7: Kitchen sink (all issues combined)
   ============================================================ */
function generateKitchenSink(n) {
  const lines = ['id,name,description,amount,date,category,status,notes'];
  const nullVariants = ['', 'NULL', 'null', 'NA', 'N/A', 'n/a', '-', 'nil', 'None', 'NaN'];

  for (let i = 1; i <= n; i++) {
    let name = randName();
    let desc = 'Description for row ' + i;
    let amount = String(randAmount());
    let date = randDate();
    let category = randCategory();
    let status = randStatus();
    let notes = 'Note ' + i;

    // Dirty whitespace (every row)
    if (Math.random() < 0.3) name = '  ' + name + '  ';
    if (Math.random() < 0.2) desc = '\t' + desc + ' ';

    // Type drift in amount (gradual transition)
    const phase = i / n;
    if (phase > 0.6 && Math.random() < 0.3) {
      amount = randChoice(['¥' + randInt(1, 999), '$' + (Math.random() * 100).toFixed(2), 'N/A']);
    }

    // Invalid dates (every 10th row)
    if (i % 10 === 0) {
      date = randChoice(['2024-13-45', 'not-a-date', '00/00/0000', '2024-02-30', '']);
    }

    // Null values (every 7th row)
    if (i % 7 === 0) {
      const nullVal = nullVariants[i % nullVariants.length];
      // Pick 1-2 random fields to nullify
      const fields = [null, null, null, null, null, null, null];
      fields[randInt(0, 6)] = nullVal;
      if (Math.random() < 0.3) fields[randInt(0, 6)] = nullVal;
      if (fields[0] !== null) name = fields[0];
      if (fields[1] !== null) desc = fields[1];
      if (fields[2] !== null) amount = fields[2];
      if (fields[3] !== null) date = fields[3];
      if (fields[4] !== null) category = fields[4];
      if (fields[5] !== null) status = fields[5];
      if (fields[6] !== null) notes = fields[6];
    }

    // Unclosed quote (every 1000th row)
    if (i % 1000 === 0) {
      desc = '"This quote is never closed';
    }

    // Smart quotes (every 2000th row)
    if (i % 2000 === 0) {
      name = '\u201c' + name + '\u201d';
    }

    // Control characters (every 500th row)
    if (i % 500 === 0) {
      notes = 'Control\x01chars\x0Bhere\x0C';
    }

    let rowStr = [i, name, desc, amount, date, category, status, notes].join(',');

    // Extra columns (every 3000th row)
    if (i % 3000 === 0) {
      rowStr += ',EXTRA_COL1,EXTRA_COL2';
    }

    // Too few columns (every 5000th row)
    if (i % 5000 === 0) {
      rowStr = [i, name, desc].join(',');
    }

    lines.push(rowStr);
  }
  return lines.join('\n') + '\n';
}
