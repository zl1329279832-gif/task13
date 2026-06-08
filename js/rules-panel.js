/* rules-panel.js — Rule list UI and rule configuration modals */

class RulesPanel {
  constructor(app) {
    this.app = app;
    this.rules = [];
    this.listEl = document.getElementById('rulesList');
    this.typeSelect = document.getElementById('ruleTypeSelect');
    this.modal = document.getElementById('ruleModal');
    this.modalTitle = document.getElementById('modalTitle');
    this.modalBody = document.getElementById('modalBody');
    this.modalConfirm = document.getElementById('modalConfirm');
    this.modalCancel = document.getElementById('modalCancel');
    this.modalCloseBtn = this.modal.querySelector('.modal-close');
    this.modalBackdrop = this.modal.querySelector('.modal-backdrop');
    this._editIdx = -1;
    this._editRule = null;

    document.getElementById('btnAddRule').addEventListener('click', () => {
      const type = this.typeSelect.value;
      if (type) { this.showConfigModal(this._defaultRule(type), -1); this.typeSelect.value = ''; }
    });
    document.getElementById('btnExecuteAll').addEventListener('click', () => this.app.executeAllRules());
    document.getElementById('btnClearRules').addEventListener('click', () => {
      if (this.rules.length && confirm('确定清空所有规则？')) { this.rules = []; this.render(); }
    });
    const closeModal = () => this.hideModal();
    this.modalCancel.addEventListener('click', closeModal);
    this.modalCloseBtn.addEventListener('click', closeModal);
    this.modalBackdrop.addEventListener('click', closeModal);
  }

  getRules() { return this.rules; }
  setRules(rules) { this.rules = deepClone(rules); this.render(); }

  _defaultRule(type) {
    const ds = this.app.getActiveDataset();
    const col = ds ? ds.headers[0] || '' : '';
    const base = { type, enabled: true };
    switch (type) {
      case 'dedup': return { ...base, name: '去重', columns: null, keep: 'first' };
      case 'nullFill': return { ...base, name: '空值填充', column: col, method: 'value', fillValue: '' };
      case 'trim': return { ...base, name: '去除首尾空白' };
      case 'fieldSplit': return { ...base, name: '字段拆分', column: col, delimiter: ',', newColumns: [] };
      case 'dateNormalize': return { ...base, name: '日期标准化', column: col, outputFormat: 'YYYY-MM-DD' };
      case 'amountConvert': return { ...base, name: '金额单位转换', column: col, factor: 1, prefix: '', suffix: '', decimals: 2 };
      case 'enumMap': return { ...base, name: '枚举映射', column: col, mapping: {} };
      case 'crossValidate': return { ...base, name: '跨表关联校验', thisColumn: col, otherDataset: '', otherColumn: '' };
      case 'rename': return { ...base, name: '字段重命名', mapping: {} };
      default: return base;
    }
  }

  render() {
    if (this.rules.length === 0) {
      this.listEl.innerHTML = '<p class="text-muted" style="text-align:center;padding:20px">暂无清洗规则，请从上方下拉菜单添加</p>';
      return;
    }
    let html = '';
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      const meta = RULE_META[r.type] || { icon: '??', label: r.type };
      const desc = this._ruleDesc(r);
      const enabled = r.enabled !== false;
      html += `<div class="rule-card" data-idx="${i}" style="${enabled ? '' : 'opacity:0.5'}">
        <div class="rule-order">${i + 1}</div>
        <div class="rule-icon" style="font-size:10px;font-weight:700;color:var(--primary)">${meta.icon}</div>
        <div class="rule-info">
          <div class="rule-name">${escHtml(r.name || meta.label)}</div>
          <div class="rule-desc">${escHtml(desc)}</div>
        </div>
        <div class="rule-actions">
          <button class="rule-toggle ${enabled ? 'on' : 'off'}" data-action="toggle" data-idx="${i}" title="${enabled ? '禁用' : '启用'}"></button>
          <button class="btn-sm" data-action="up" data-idx="${i}" title="上移" ${i === 0 ? 'disabled' : ''}>^</button>
          <button class="btn-sm" data-action="down" data-idx="${i}" title="下移" ${i === this.rules.length - 1 ? 'disabled' : ''}>v</button>
          <button class="btn-sm" data-action="edit" data-idx="${i}" title="编辑">Edit</button>
          <button class="btn-sm btn-danger" data-action="remove" data-idx="${i}" title="删除">x</button>
        </div>
      </div>`;
    }
    this.listEl.innerHTML = html;
    this.listEl.onclick = (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const idx = parseInt(btn.dataset.idx);
      switch (btn.dataset.action) {
        case 'toggle': this.rules[idx].enabled = !this.rules[idx].enabled; this.render(); break;
        case 'up': if (idx > 0) { [this.rules[idx-1], this.rules[idx]] = [this.rules[idx], this.rules[idx-1]]; this.render(); } break;
        case 'down': if (idx < this.rules.length-1) { [this.rules[idx+1], this.rules[idx]] = [this.rules[idx], this.rules[idx+1]]; this.render(); } break;
        case 'edit': this.showConfigModal(deepClone(this.rules[idx]), idx); break;
        case 'remove': this.rules.splice(idx, 1); this.render(); break;
      }
    };
  }

  _ruleDesc(r) {
    switch (r.type) {
      case 'dedup': return `按${r.columns ? r.columns.join(', ') : '全部列'}去重，保留${r.keep === 'last' ? '最后' : '第一'}条`;
      case 'nullFill': return `${r.column} - ${r.method === 'value' ? '填充 "' + r.fillValue + '"' : r.method}`;
      case 'trim': return '去除所有字段首尾空白';
      case 'fieldSplit': return `拆分 ${r.column}，分隔符 "${r.delimiter}"`;
      case 'dateNormalize': return `${r.column} -> ${r.outputFormat}`;
      case 'amountConvert': return `${r.column} x ${r.factor}${r.prefix ? '，前缀 ' + r.prefix : ''}${r.suffix ? '，后缀 ' + r.suffix : ''}`;
      case 'enumMap': return `${r.column}: ${Object.keys(r.mapping).length} 个映射`;
      case 'crossValidate': return `${r.thisColumn} <-> ${r.otherDataset}.${r.otherColumn}`;
      case 'rename': return `${Object.keys(r.mapping).length} 个字段重命名`;
      default: return r.type;
    }
  }

  showConfigModal(rule, idx) {
    this._editRule = rule;
    this._editIdx = idx;
    this.modalTitle.textContent = (idx >= 0 ? '编辑规则 - ' : '添加规则 - ') + (rule.name || ruleLabel(rule.type));
    this.modalBody.innerHTML = this._buildForm(rule);
    this._bindFormEvents(rule);
    this.modal.style.display = 'flex';
    this.modalConfirm.onclick = () => {
      this._collectForm(rule);
      if (idx >= 0) this.rules[idx] = rule; else this.rules.push(rule);
      this.render();
      this.hideModal();
    };
  }

  hideModal() { this.modal.style.display = 'none'; this._editRule = null; this._editIdx = -1; }

  _buildForm(rule) {
    const ds = this.app.getActiveDataset();
    const cols = ds ? ds.headers : [];
    const colOpts = cols.map(c => `<option value="${escHtml(c)}" ${c === rule.column ? 'selected' : ''}>${escHtml(c)}</option>`).join('');
    const datasets = this.app.getAllDatasetNames();

    switch (rule.type) {
      case 'dedup': {
        const checks = cols.map(c => {
          const checked = !rule.columns || rule.columns.includes(c) ? 'checked' : '';
          return `<label style="display:inline-block;margin:2px 6px 2px 0"><input type="checkbox" class="dedup-col" value="${escHtml(c)}" ${checked}> ${escHtml(c)}</label>`;
        }).join('');
        return `<div class="form-group"><label>去重列（全选=全部列）</label><div>${checks}</div></div>
          <div class="form-group"><label>保留策略</label><select id="dedupKeep"><option value="first" ${rule.keep==='first'?'selected':''}>保留第一条</option><option value="last" ${rule.keep==='last'?'selected':''}>保留最后一条</option></select></div>
          <div class="form-group"><label>规则名称</label><input id="ruleName" value="${escHtml(rule.name||'')}"></div>`;
      }
      case 'nullFill':
        return `<div class="form-group"><label>目标列</label><select id="ruleColumn">${colOpts}</select></div>
          <div class="form-group"><label>填充方式</label><select id="ruleMethod">
            <option value="value" ${rule.method==='value'?'selected':''}>指定值</option>
            <option value="mean" ${rule.method==='mean'?'selected':''}>均值</option>
            <option value="median" ${rule.method==='median'?'selected':''}>中位数</option>
            <option value="mode" ${rule.method==='mode'?'selected':''}>众数</option>
            <option value="forward" ${rule.method==='forward'?'selected':''}>前值填充</option>
            <option value="backward" ${rule.method==='backward'?'selected':''}>后值填充</option>
          </select></div>
          <div class="form-group" id="fillValueGroup" style="${rule.method!=='value'?'display:none':''}"><label>填充值</label><input id="ruleFillValue" value="${escHtml(rule.fillValue||'')}"></div>
          <div class="form-group"><label>规则名称</label><input id="ruleName" value="${escHtml(rule.name||'')}"></div>`;
      case 'fieldSplit':
        return `<div class="form-group"><label>目标列</label><select id="ruleColumn">${colOpts}</select></div>
          <div class="form-row"><div class="form-group"><label>分隔符</label><input id="ruleDelimiter" value="${escHtml(rule.delimiter||',')}"></div>
          <div class="form-group"><label>新列名（逗号分隔，可留空）</label><input id="ruleNewCols" value="${escHtml((rule.newColumns||[]).join(','))}"></div></div>
          <div class="form-group"><label>规则名称</label><input id="ruleName" value="${escHtml(rule.name||'')}"></div>`;
      case 'dateNormalize':
        return `<div class="form-group"><label>日期列</label><select id="ruleColumn">${colOpts}</select></div>
          <div class="form-group"><label>输出格式</label><select id="ruleFormat">
            <option value="YYYY-MM-DD" ${rule.outputFormat==='YYYY-MM-DD'?'selected':''}>YYYY-MM-DD</option>
            <option value="YYYY/MM/DD" ${rule.outputFormat==='YYYY/MM/DD'?'selected':''}>YYYY/MM/DD</option>
            <option value="DD/MM/YYYY" ${rule.outputFormat==='DD/MM/YYYY'?'selected':''}>DD/MM/YYYY</option>
            <option value="YYYY-MM-DD HH:mm:ss" ${rule.outputFormat==='YYYY-MM-DD HH:mm:ss'?'selected':''}>YYYY-MM-DD HH:mm:ss</option>
            <option value="YYYYMMDD" ${rule.outputFormat==='YYYYMMDD'?'selected':''}>YYYYMMDD</option>
          </select></div>
          <div class="form-group"><label>规则名称</label><input id="ruleName" value="${escHtml(rule.name||'')}"></div>`;
      case 'amountConvert':
        return `<div class="form-group"><label>金额列</label><select id="ruleColumn">${colOpts}</select></div>
          <div class="form-row"><div class="form-group"><label>转换系数</label><input id="ruleFactor" type="number" step="any" value="${rule.factor}"><div class="hint">分->元: 0.01, 元->分: 100, 万->元: 10000</div></div>
          <div class="form-group"><label>小数位数</label><input id="ruleDecimals" type="number" value="${rule.decimals}"></div></div>
          <div class="form-row"><div class="form-group"><label>前缀</label><input id="rulePrefix" value="${escHtml(rule.prefix||'')}"><div class="hint">如: ¥, $</div></div>
          <div class="form-group"><label>后缀</label><input id="ruleSuffix" value="${escHtml(rule.suffix||'')}"><div class="hint">如: 元, USD</div></div></div>
          <div class="form-group"><label>规则名称</label><input id="ruleName" value="${escHtml(rule.name||'')}"></div>`;
      case 'enumMap': {
        const profile = ds && ds.profile ? ds.profile.profiles.find(p => p.column === rule.column) : null;
        let enumTable = '';
        if (profile && profile.enumValues) {
          enumTable = profile.enumValues.map(e =>
            `<div class="form-row"><div class="form-group"><input class="enum-key" value="${escHtml(e.value)}" readonly></div><div class="form-group"><input class="enum-val" value="${escHtml(rule.mapping[e.value]||'')}" placeholder="映射值"></div></div>`
          ).join('');
        }
        return `<div class="form-group"><label>目标列</label><select id="ruleColumn">${colOpts}</select></div>
          <div class="form-group"><label>映射表</label>${enumTable || '<div class="hint">选择枚举列后显示映射表</div>'}</div>
          <div class="form-group"><label>或 JSON 格式</label><textarea id="ruleMappingJSON">${escHtml(JSON.stringify(rule.mapping||{},null,2))}</textarea></div>
          <div class="form-group"><label>规则名称</label><input id="ruleName" value="${escHtml(rule.name||'')}"></div>`;
      }
      case 'crossValidate': {
        const dsOpts = datasets.filter(d => d !== this.app.activeDatasetName).map(d => `<option value="${escHtml(d)}" ${d===rule.otherDataset?'selected':''}>${escHtml(d)}</option>`).join('');
        return `<div class="form-group"><label>本表列</label><select id="ruleThisColumn">${colOpts}</select></div>
          <div class="form-group"><label>关联数据集</label><select id="ruleOtherDs"><option value="">-- 选择 --</option>${dsOpts}</select></div>
          <div class="form-group"><label>关联列</label><select id="ruleOtherCol"><option value="">-- 先选择数据集 --</option></select></div>
          <div class="form-group"><label>规则名称</label><input id="ruleName" value="${escHtml(rule.name||'')}"></div>`;
      }
      case 'rename': {
        const rows = cols.map(c =>
          `<div class="form-row"><div class="form-group"><input class="rename-key" value="${escHtml(c)}" readonly></div><div class="form-group"><input class="rename-val" value="${escHtml(rule.mapping[c]||'')}" placeholder="新名称（留空不改）"></div></div>`
        ).join('');
        return `<div class="form-group"><label>字段重命名</label>${rows}</div>
          <div class="form-group"><label>或 JSON 格式</label><textarea id="ruleRenameJSON">${escHtml(JSON.stringify(rule.mapping||{},null,2))}</textarea></div>
          <div class="form-group"><label>规则名称</label><input id="ruleName" value="${escHtml(rule.name||'')}"></div>`;
      }
      case 'trim':
        return `<div class="form-group"><label>规则名称</label><input id="ruleName" value="${escHtml(rule.name||'去除首尾空白')}"><div class="hint">去除所有字段值的首尾空白字符</div></div>`;
      default: return '<p>未知的规则类型</p>';
    }
  }

  _bindFormEvents(rule) {
    const methodEl = document.getElementById('ruleMethod');
    if (methodEl) {
      methodEl.addEventListener('change', () => {
        document.getElementById('fillValueGroup').style.display = methodEl.value === 'value' ? '' : 'none';
      });
    }
    const otherDsEl = document.getElementById('ruleOtherDs');
    if (otherDsEl) {
      otherDsEl.addEventListener('change', () => {
        const otherColEl = document.getElementById('ruleOtherCol');
        if (otherDsEl.value) {
          const ds = this.app.getDataset(otherDsEl.value);
          if (ds) otherColEl.innerHTML = ds.headers.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
        } else {
          otherColEl.innerHTML = '<option value="">-- 先选择数据集 --</option>';
        }
      });
      if (otherDsEl.value) otherDsEl.dispatchEvent(new Event('change'));
    }
  }

  _collectForm(rule) {
    const nameEl = document.getElementById('ruleName');
    if (nameEl && nameEl.value.trim()) rule.name = nameEl.value.trim();

    switch (rule.type) {
      case 'dedup': {
        const checks = document.querySelectorAll('.dedup-col:checked');
        const all = document.querySelectorAll('.dedup-col');
        rule.columns = checks.length === all.length ? null : [...checks].map(c => c.value);
        rule.keep = document.getElementById('dedupKeep').value;
        break;
      }
      case 'nullFill':
        rule.column = document.getElementById('ruleColumn').value;
        rule.method = document.getElementById('ruleMethod').value;
        rule.fillValue = document.getElementById('ruleFillValue').value;
        break;
      case 'fieldSplit':
        rule.column = document.getElementById('ruleColumn').value;
        rule.delimiter = document.getElementById('ruleDelimiter').value;
        const nc = document.getElementById('ruleNewCols').value.trim();
        rule.newColumns = nc ? nc.split(',').map(s => s.trim()) : [];
        break;
      case 'dateNormalize':
        rule.column = document.getElementById('ruleColumn').value;
        rule.outputFormat = document.getElementById('ruleFormat').value;
        break;
      case 'amountConvert':
        rule.column = document.getElementById('ruleColumn').value;
        rule.factor = parseFloat(document.getElementById('ruleFactor').value) || 1;
        rule.decimals = parseInt(document.getElementById('ruleDecimals').value) || 2;
        rule.prefix = document.getElementById('rulePrefix').value;
        rule.suffix = document.getElementById('ruleSuffix').value;
        break;
      case 'enumMap': {
        rule.column = document.getElementById('ruleColumn').value;
        const jsonStr = document.getElementById('ruleMappingJSON').value.trim();
        try { rule.mapping = JSON.parse(jsonStr); } catch {
          const keys = document.querySelectorAll('.enum-key');
          const vals = document.querySelectorAll('.enum-val');
          const mapping = {};
          for (let i = 0; i < keys.length; i++) { if (vals[i].value.trim()) mapping[keys[i].value] = vals[i].value.trim(); }
          rule.mapping = mapping;
        }
        break;
      }
      case 'crossValidate':
        rule.thisColumn = document.getElementById('ruleThisColumn').value;
        rule.otherDataset = document.getElementById('ruleOtherDs').value;
        rule.otherColumn = document.getElementById('ruleOtherCol').value;
        break;
      case 'rename': {
        const jsonStr2 = document.getElementById('ruleRenameJSON') ? document.getElementById('ruleRenameJSON').value.trim() : '';
        try { if (jsonStr2) rule.mapping = JSON.parse(jsonStr2); } catch {
          const keys = document.querySelectorAll('.rename-key');
          const vals = document.querySelectorAll('.rename-val');
          const mapping = {};
          for (let i = 0; i < keys.length; i++) { if (vals[i].value.trim() && vals[i].value.trim() !== keys[i].value) mapping[keys[i].value] = vals[i].value.trim(); }
          rule.mapping = mapping;
        }
        break;
      }
    }
  }
}
