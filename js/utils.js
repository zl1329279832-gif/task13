/* utils.js — Shared utilities */

function toast(msg, type, duration) {
  type = type || '';
  duration = duration || 3000;
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, duration);
}

function showLoading(text, progress) {
  const overlay = document.getElementById('loadingOverlay');
  overlay.style.display = 'flex';
  document.getElementById('loadingText').textContent = text || '处理中...';
  if (progress != null) {
    document.getElementById('progressFill').style.width = Math.round(progress * 100) + '%';
  }
}
function hideLoading() {
  document.getElementById('loadingOverlay').style.display = 'none';
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function fmtNum(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('en-US');
}

function escHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function toCSV(headers, rows) {
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  let csv = headers.map(escape).join(',') + '\n';
  for (const row of rows) {
    csv += row.map(escape).join(',') + '\n';
  }
  return csv;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file: ' + file.name));
    reader.readAsText(file, 'UTF-8');
  });
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

const RULE_META = {
  dedup:         { icon: 'DUP', label: '去重' },
  nullFill:      { icon: 'NIL', label: '空值填充' },
  trim:          { icon: 'TRM', label: '去除空白' },
  fieldSplit:    { icon: 'SPL', label: '字段拆分' },
  dateNormalize: { icon: 'DAT', label: '日期标准化' },
  amountConvert: { icon: 'AMT', label: '金额单位转换' },
  enumMap:       { icon: 'ENM', label: '枚举映射' },
  crossValidate: { icon: 'XRF', label: '跨表关联校验' },
  rename:        { icon: 'REN', label: '字段重命名' },
};

function ruleIcon(type) { return (RULE_META[type] || {}).icon || '???'; }
function ruleLabel(type) { return (RULE_META[type] || {}).label || type; }
