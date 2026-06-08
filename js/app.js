/* app.js — Main application controller */

class App {
  constructor() {
    /** @type {Map<string, {name, headers, rows, profile, originalHeaders, originalRows}>} */
    this.datasets = new Map();
    this.activeDatasetName = null;

    this.worker = new WorkerBridge('worker.js');
    this.grid = new DataGrid(document.getElementById('dataView'));
    this.rulesPanel = new RulesPanel(this);
    this.resultsView = new ResultsView(this);

    /** Undo/redo history */
    this.history = [];
    this.historyIdx = -1;
    this.maxHistory = 50;

    this._initUI();
    this._initDragDrop();
    this._initKeyboard();
  }

  _initUI() {
    document.querySelectorAll('#tabBar .tab').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    document.getElementById('btnUndo').addEventListener('click', () => this.undo());
    document.getElementById('btnRedo').addEventListener('click', () => this.redo());
    document.getElementById('btnSaveRules').addEventListener('click', () => this.saveRules());
    document.getElementById('btnLoadRules').addEventListener('click', () => this.loadRules());
    document.getElementById('btnExportCSV').addEventListener('click', () => this.exportCSV());
    document.getElementById('btnExportReport').addEventListener('click', () => this.exportReport());
    document.getElementById('btnExportRules').addEventListener('click', () => this.exportRulesJSON());

    document.getElementById('dropHint').addEventListener('click', () => document.getElementById('fileInput').click());
    document.getElementById('fileInput').addEventListener('change', (e) => {
      if (e.target.files.length) this.handleFiles(e.target.files);
      e.target.value = '';
    });

    document.getElementById('rulesFileInput').addEventListener('change', (e) => {
      if (e.target.files.length) this._importRulesFile(e.target.files[0]);
      e.target.value = '';
    });
  }

  _initDragDrop() {
    const overlay = document.getElementById('dropOverlay');
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      overlay.classList.add('visible');
    });
    document.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('visible'); }
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      overlay.classList.remove('visible');
      if (e.dataTransfer.files.length) this.handleFiles(e.dataTransfer.files);
    });
  }

  _initKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
        else if (e.key === 'z' && e.shiftKey) { e.preventDefault(); this.redo(); }
        else if (e.key === 'y') { e.preventDefault(); this.redo(); }
        else if (e.key === 's') { e.preventDefault(); this.saveRules(); }
      }
    });
  }

  /* ============================================================
     File Handling
     ============================================================ */
  async handleFiles(fileList) {
    const csvFiles = [...fileList].filter(f =>
      f.name.endsWith('.csv') || f.name.endsWith('.tsv') || f.name.endsWith('.txt') || f.type === 'text/csv'
    );
    if (csvFiles.length === 0) { toast('未找到 CSV 文件', 'warning'); return; }

    showLoading(`正在解析 ${csvFiles.length} 个文件...`, 0);

    for (let i = 0; i < csvFiles.length; i++) {
      const file = csvFiles[i];
      try {
        showLoading(`解析 ${file.name} (${i+1}/${csvFiles.length})...`, i / csvFiles.length);
        const text = await readFileAsText(file);
        const result = await this.worker.parseCSV(text, {});

        const name = file.name.replace(/\.(csv|tsv|txt)$/i, '');
        let uniqueName = name;
        let counter = 1;
        while (this.datasets.has(uniqueName)) uniqueName = name + '_' + counter++;

        this.datasets.set(uniqueName, {
          name: uniqueName,
          fileName: file.name,
          headers: result.headers,
          rows: result.rows,
          profile: result.profile,
          originalHeaders: result.headers.slice(),
          originalRows: result.rows.map(r => r.slice()),
        });

        toast(`${uniqueName}: ${fmtNum(result.rows.length)} 行 x ${result.headers.length} 列`, 'success');
      } catch (err) {
        toast(`${file.name}: ${err.message}`, 'error');
      }
    }

    hideLoading();

    if (!this.activeDatasetName || !this.datasets.has(this.activeDatasetName)) {
      this.activeDatasetName = this.datasets.keys().next().value;
    }

    this._renderDatasetList();
    this._showDataView();
    this._renderActiveDataset();
    this._pushHistory();
  }

  /* ============================================================
     Dataset Management
     ============================================================ */
  getActiveDataset() { return this.datasets.get(this.activeDatasetName) || null; }
  getDataset(name) { return this.datasets.get(name) || null; }
  getAllDatasetNames() { return [...this.datasets.keys()]; }

  getAllDatasetsForWorker() {
    const all = {};
    for (const [name, ds] of this.datasets) all[name] = { headers: ds.headers, rows: ds.rows };
    return all;
  }

  removeDataset(name) {
    this.datasets.delete(name);
    if (this.activeDatasetName === name) {
      this.activeDatasetName = this.datasets.size > 0 ? this.datasets.keys().next().value : null;
    }
    this._renderDatasetList();
    if (this.activeDatasetName) this._renderActiveDataset();
    else this._showWelcome();
  }

  _renderDatasetList() {
    const listEl = document.getElementById('datasetList');
    if (this.datasets.size === 0) { listEl.innerHTML = ''; return; }
    let html = '';
    for (const [name, ds] of this.datasets) {
      const isActive = name === this.activeDatasetName;
      html += `<div class="dataset-item ${isActive ? 'active' : ''}" data-name="${escHtml(name)}">
        <span class="ds-name" title="${escHtml(ds.fileName || name)}">${escHtml(name)}</span>
        <span class="ds-meta">${fmtNum(ds.rows.length)}</span>
        <span class="ds-remove" data-remove="${escHtml(name)}" title="移除">x</span>
      </div>`;
    }
    listEl.innerHTML = html;

    listEl.onclick = (e) => {
      const removeBtn = e.target.closest('[data-remove]');
      if (removeBtn) {
        e.stopPropagation();
        if (confirm(`移除数据集 "${removeBtn.dataset.remove}"？`)) this.removeDataset(removeBtn.dataset.remove);
        return;
      }
      const item = e.target.closest('.dataset-item');
      if (item) {
        this.activeDatasetName = item.dataset.name;
        this._renderDatasetList();
        this._renderActiveDataset();
        this._pushHistory();
      }
    };
  }

  _showDataView() {
    document.getElementById('welcomeScreen').style.display = 'none';
    document.getElementById('dataView').style.display = 'flex';
    document.getElementById('dataView').style.flexDirection = 'column';
    document.getElementById('dataView').style.flex = '1';
    document.getElementById('dataView').style.overflow = 'hidden';
  }

  _showWelcome() {
    document.getElementById('welcomeScreen').style.display = 'flex';
    document.getElementById('dataView').style.display = 'none';
  }

  _renderActiveDataset() {
    const ds = this.getActiveDataset();
    if (!ds) return;

    this.grid.setData(ds.headers, ds.rows, ds.profile);
    this._renderProfile(ds);
    this._renderProfileSummary(ds);

    document.getElementById('btnExportCSV').disabled = false;
    document.getElementById('btnExportReport').disabled = false;
  }

  /* ============================================================
     Tab Switching
     ============================================================ */
  switchTab(tabName) {
    document.querySelectorAll('#tabBar .tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-content').forEach(tc => {
      tc.style.display = 'none';
      tc.classList.remove('active');
    });
    const tabEl = document.getElementById('tab' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
    if (tabEl) { tabEl.style.display = ''; tabEl.classList.add('active'); }
    if (tabName === 'data') requestAnimationFrame(() => this.grid.render());
  }

  /* ============================================================
     Profile Rendering
     ============================================================ */
  _renderProfile(ds) {
    const profile = ds.profile;
    if (!profile) return;

    this._drawQualityScore(profile.quality);

    const breakdown = document.getElementById('qualityBreakdown');
    const bd = profile.qualityBreakdown;
    breakdown.innerHTML = `
      <div class="qb-item"><span class="qb-label">完整性</span><div class="qb-bar"><div class="qb-fill" style="width:${bd.completeness}%;background:var(--success)"></div></div><span class="qb-value">${bd.completeness}%</span></div>
      <div class="qb-item"><span class="qb-label">唯一性</span><div class="qb-bar"><div class="qb-fill" style="width:${bd.uniqueness}%;background:var(--info)"></div></div><span class="qb-value">${bd.uniqueness}%</span></div>
      <div class="qb-item"><span class="qb-label">有效性</span><div class="qb-bar"><div class="qb-fill" style="width:${bd.validity}%;background:var(--warning)"></div></div><span class="qb-value">${bd.validity}%</span></div>`;

    const container = document.getElementById('columnProfiles');
    container.innerHTML = profile.profiles.map(p => this._renderColProfile(p)).join('');
  }

  _drawQualityScore(score) {
    const canvas = document.getElementById('qualityCanvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2, r = 46;

    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#e2e6ea';
    ctx.lineWidth = 10;
    ctx.stroke();

    const pct = score / 100;
    const color = score >= 80 ? '#27ae60' : score >= 50 ? '#f39c12' : '#e74c3c';
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
    ctx.strokeStyle = color;
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = 'bold 28px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(score, cx, cy);
  }

  _renderColProfile(p) {
    const typeLabels = { integer: '整数', float: '浮点', date: '日期', email: '邮箱', phone: '电话', boolean: '布尔', string: '文本' };
    const badges = [];
    if (p.isPrimaryKey) badges.push('<span class="badge badge-pk">主键</span>');
    if (p.isEnum) badges.push('<span class="badge badge-enum">枚举</span>');
    if (p.dirtyCount > 0) badges.push(`<span class="badge badge-dirty">${p.dirtyCount} 脏值</span>`);

    let enumHtml = '';
    if (p.isEnum && p.enumValues) {
      enumHtml = `<div class="cp-enum"><div class="cp-enum-title">枚举值 (${p.uniqueCount})</div>` +
        p.enumValues.slice(0, 8).map(e => `<div class="cp-enum-item"><span class="ev-val">${escHtml(e.value)}</span><span class="ev-count">${fmtNum(e.count)}</span></div>`).join('') + '</div>';
    }

    let dirtyHtml = '';
    if (p.dirtyCount > 0 && p.dirtySamples.length > 0) {
      dirtyHtml = `<div class="cp-dirty">! ${p.dirtyCount} 个疑似脏值, 如: "${escHtml(String(p.dirtySamples[0].value))}" (行 ${p.dirtySamples[0].row + 1})</div>`;
    }

    return `<div class="col-profile-card type-${p.type}">
      <div class="cp-header"><span class="cp-name">${escHtml(p.column)}</span><span class="cp-type ${p.isPrimaryKey ? 'pk' : ''}">${typeLabels[p.type] || p.type} ${p.typeConfidence}%</span></div>
      <div style="display:flex;gap:3px;flex-wrap:wrap">${badges.join('')}</div>
      <div class="cp-stats">
        <div class="cp-stat"><span class="label">非空</span><span class="value">${fmtNum(p.validCount + p.dirtyCount)}</span></div>
        <div class="cp-stat"><span class="label">空值</span><span class="value ${p.nullCount > 0 ? 'text-danger' : ''}">${fmtNum(p.nullCount)} (${p.nullRate}%)</span></div>
        <div class="cp-stat"><span class="label">唯一值</span><span class="value">${fmtNum(p.uniqueCount)}</span></div>
        <div class="cp-stat"><span class="label">脏数据</span><span class="value ${p.dirtyCount > 0 ? 'text-danger' : ''}">${fmtNum(p.dirtyCount)}</span></div>
      </div>
      <div class="cp-samples">${p.sampleValues.map(v => `<span class="sample-tag">${escHtml(v)}</span>`).join('')}</div>
      ${enumHtml}${dirtyHtml}
    </div>`;
  }

  _renderProfileSummary(ds) {
    const el = document.getElementById('profileSummary');
    const content = document.getElementById('profileContent');
    const p = ds.profile;
    if (!p) { el.style.display = 'none'; return; }
    el.style.display = '';
    content.innerHTML = `
      <div class="profile-stat"><span class="stat-label">总行数</span><span class="stat-value">${fmtNum(p.rowCount)}</span></div>
      <div class="profile-stat"><span class="stat-label">总列数</span><span class="stat-value">${p.columnCount}</span></div>
      <div class="profile-stat"><span class="stat-label">重复行</span><span class="stat-value ${p.duplicateCount > 0 ? 'text-danger' : ''}">${fmtNum(p.duplicateCount)}</span></div>
      <div class="profile-stat"><span class="stat-label">质量评分</span><span class="stat-value">${p.quality}</span></div>`;
  }

  /* ============================================================
     Rule Execution
     ============================================================ */
  async executeAllRules() {
    const ds = this.getActiveDataset();
    if (!ds) { toast('请先导入数据', 'warning'); return; }
    const rules = this.rulesPanel.getRules().filter(r => r.enabled !== false);
    if (rules.length === 0) { toast('请先添加清洗规则', 'warning'); return; }

    showLoading('执行清洗规则...', 0);
    const profileBefore = deepClone(ds.profile);

    try {
      const allDatasets = this.getAllDatasetsForWorker();
      const result = await this.worker.executeRules(ds.headers.slice(), ds.rows.map(r => r.slice()), rules, allDatasets);

      ds.headers = result.headers;
      ds.rows = result.rows;

      const newProfile = await this.worker.profile(result.headers, result.rows);
      ds.profile = newProfile.profile;

      hideLoading();

      this.resultsView.show(result, profileBefore);
      this.switchTab('results');
      this._pushHistory();
      this._renderActiveDataset();

      toast(`清洗完成! 质量 ${profileBefore.quality} -> ${ds.profile.quality}`, ds.profile.quality >= profileBefore.quality ? 'success' : 'warning');
    } catch (err) {
      hideLoading();
      toast('执行失败: ' + err.message, 'error');
    }
  }

  /* ============================================================
     Undo / Redo
     ============================================================ */
  _pushHistory() {
    const ds = this.getActiveDataset();
    if (!ds) return;

    if (this.historyIdx < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIdx + 1);
    }

    this.history.push({
      datasetName: this.activeDatasetName,
      headers: ds.headers.slice(),
      rows: ds.rows.map(r => r.slice()),
      profile: deepClone(ds.profile),
      rulesSnapshot: deepClone(this.rulesPanel.getRules()),
    });

    if (this.history.length > this.maxHistory) this.history.shift();
    this.historyIdx = this.history.length - 1;
    this._updateUndoRedoButtons();
  }

  undo() {
    if (this.historyIdx <= 0) return;
    this.historyIdx--;
    this._restoreHistory();
  }

  redo() {
    if (this.historyIdx >= this.history.length - 1) return;
    this.historyIdx++;
    this._restoreHistory();
  }

  _restoreHistory() {
    const snap = this.history[this.historyIdx];
    if (!snap) return;

    this.activeDatasetName = snap.datasetName;
    const ds = this.datasets.get(snap.datasetName);
    if (ds) {
      ds.headers = snap.headers.slice();
      ds.rows = snap.rows.map(r => r.slice());
      ds.profile = deepClone(snap.profile);
    }

    this.rulesPanel.setRules(snap.rulesSnapshot);
    this._renderDatasetList();
    this._renderActiveDataset();
    this._updateUndoRedoButtons();
  }

  _updateUndoRedoButtons() {
    document.getElementById('btnUndo').disabled = this.historyIdx <= 0;
    document.getElementById('btnRedo').disabled = this.historyIdx >= this.history.length - 1;
  }

  /* ============================================================
     Save / Load Rules
     ============================================================ */
  async saveRules() {
    const rules = this.rulesPanel.getRules();
    if (rules.length === 0) { toast('暂无规则可保存', 'warning'); return; }

    const name = prompt('规则配置名称:', (this.activeDatasetName || 'data') + '_rules') || 'default_rules';
    const id = name.replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, '_');

    try {
      await store.saveRules(id, name, rules);
      toast(`规则已保存: ${name}`, 'success');
    } catch (err) {
      toast('保存失败: ' + err.message, 'error');
    }
  }

  async loadRules() {
    try {
      const allRules = await store.listRules();
      if (allRules.length === 0) {
        document.getElementById('rulesFileInput').click();
        return;
      }

      const names = allRules.map((r, i) => `${i + 1}. ${r.name} (${new Date(r.savedAt).toLocaleString()})`).join('\n');
      const choice = prompt('输入序号选择规则配置:\n' + names + '\n\n或输入 0 从 JSON 文件导入');
      if (!choice) return;

      const idx = parseInt(choice) - 1;
      if (idx === -1) { document.getElementById('rulesFileInput').click(); return; }
      if (idx >= 0 && idx < allRules.length) {
        this.rulesPanel.setRules(allRules[idx].rules);
        toast(`已加载: ${allRules[idx].name}`, 'success');
        this.switchTab('rules');
      }
    } catch (err) {
      document.getElementById('rulesFileInput').click();
    }
  }

  async _importRulesFile(file) {
    try {
      const text = await readFileAsText(file);
      const data = JSON.parse(text);
      if (Array.isArray(data)) {
        this.rulesPanel.setRules(data);
        toast(`已导入 ${data.length} 条规则`, 'success');
        this.switchTab('rules');
      } else if (data.rules && Array.isArray(data.rules)) {
        this.rulesPanel.setRules(data.rules);
        toast(`已导入 ${data.rules.length} 条规则`, 'success');
        this.switchTab('rules');
      } else {
        toast('无效的 JSON 格式', 'error');
      }
    } catch (err) {
      toast('导入失败: ' + err.message, 'error');
    }
  }

  /* ============================================================
     Export
     ============================================================ */
  exportCSV() {
    const ds = this.getActiveDataset();
    if (!ds) return;
    const csv = toCSV(ds.headers, ds.rows);
    const filename = (ds.name || 'cleaned') + '_cleaned.csv';
    downloadFile('\uFEFF' + csv, filename, 'text/csv;charset=utf-8');
    toast(`已导出 ${filename}`, 'success');
  }

  exportReport() {
    const report = this.resultsView.generateReport();
    if (!report) { toast('请先执行清洗规则', 'warning'); return; }
    const filename = (this.activeDatasetName || 'data') + '_report.txt';
    downloadFile(report, filename, 'text/plain;charset=utf-8');
    toast('已导出错误报告', 'success');
  }

  exportRulesJSON() {
    const rules = this.rulesPanel.getRules();
    if (rules.length === 0) { toast('暂无规则可导出', 'warning'); return; }
    const json = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), rules }, null, 2);
    downloadFile(json, 'cleaning_rules.json', 'application/json');
    toast('已导出规则配置', 'success');
  }
}

/* Boot */
(async function init() {
  try { await store.open(); } catch (e) { console.warn('IndexedDB init failed:', e); }
  window.app = new App();
})();
