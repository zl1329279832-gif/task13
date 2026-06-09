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
    this.recipeManager = new RecipeManager(this);
    this.recipePlayer = new RecipePlayer(this);
    this.recipePanel = new RecipePanel(this);

    /** Max undo history per dataset */
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
    document.getElementById('btnExportRecipe').addEventListener('click', () => this.exportRecipeJSON());

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

    // Start a new task version — any in-flight parse/profile/export tasks are invalidated
    this.worker.startNewTaskVersion();
    const myVersion = this.worker.currentTaskVersion;

    showLoading(`正在解析 ${csvFiles.length} 个文件...`, 0);

    for (let i = 0; i < csvFiles.length; i++) {
      const file = csvFiles[i];
      try {
        // Check if a newer import was triggered while we were waiting
        if (this.worker.currentTaskVersion !== myVersion) { hideLoading(); return; }

        showLoading(`读取 ${file.name} (${i+1}/${csvFiles.length})...`, i / csvFiles.length);

        // Read file with progress callback (chunked streaming)
        const text = await readFileAsText(file, (p) => {
          showLoading(`读取 ${file.name}...`, (i + p) / csvFiles.length);
        });

        // Re-check version after file read (could have taken seconds for large files)
        if (this.worker.currentTaskVersion !== myVersion) { hideLoading(); return; }

        showLoading(`解析 ${file.name} (${i+1}/${csvFiles.length})...`, (i + 0.5) / csvFiles.length);
        const result = await this.worker.parseCSV(text, {});

        // Re-check version after worker parse
        if (this.worker.currentTaskVersion !== myVersion) { hideLoading(); return; }

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
          parseErrors: result.parseErrors || [],
          history: [],      // per-dataset undo stack
          historyIdx: -1,   // per-dataset undo pointer
        });

        if (result.parseErrors && result.parseErrors.length > 0) {
          toast(`${uniqueName}: ${result.parseErrors.length} 个解析警告`, 'warning');
        }
        toast(`${uniqueName}: ${fmtNum(result.rows.length)} 行 x ${result.headers.length} 列`, 'success');
      } catch (err) {
        if (err.message === 'STALE_TASK' || err.message === 'CANCELLED') { hideLoading(); return; }
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
    const ds = this.datasets.get(name);
    if (ds) {
      // Clean up per-dataset history to free memory
      ds.history = [];
      ds.historyIdx = -1;
    }
    this.datasets.delete(name);
    if (this.activeDatasetName === name) {
      this.activeDatasetName = this.datasets.size > 0 ? this.datasets.keys().next().value : null;
    }
    this._renderDatasetList();
    if (this.activeDatasetName) {
      this._renderActiveDataset();
      this._updateUndoRedoButtons();
    } else {
      this._showWelcome();
    }
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
        // Don't push history on dataset switch — just update button state
        this._updateUndoRedoButtons();
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
    this._updateUndoRedoButtons();
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
    if (tabName === 'recipe') this.recipePanel.render();
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
    const typeLabels = { integer: '整数', float: '浮点', money: '金额', date: '日期', email: '邮箱', phone: '电话', boolean: '布尔', mixed: '混合', string: '文本' };
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

    // Start a new task version — any in-flight parse tasks are invalidated
    this.worker.startNewTaskVersion();
    const myVersion = this.worker.currentTaskVersion;

    showLoading('执行清洗规则...', 0);
    const profileBefore = deepClone(ds.profile);

    try {
      const allDatasets = this.getAllDatasetsForWorker();
      const result = await this.worker.executeRules(
        ds.headers.slice(), ds.rows.map(r => r.slice()), rules, allDatasets
      );

      // Check if a new import/clean was triggered while rules were executing
      if (this.worker.currentTaskVersion !== myVersion) { hideLoading(); return; }

      ds.headers = result.headers;
      ds.rows = result.rows;

      showLoading('重新分析数据画像...', 0.9);
      const newProfile = await this.worker.profile(result.headers, result.rows);

      // Check version again after profile re-computation
      if (this.worker.currentTaskVersion !== myVersion) { hideLoading(); return; }

      ds.profile = newProfile.profile;

      hideLoading();

      this.resultsView.show(result, profileBefore);
      this.switchTab('results');
      this._pushHistory();
      this._renderActiveDataset();

      toast(`清洗完成! 质量 ${profileBefore.quality} -> ${ds.profile.quality}`,
        ds.profile.quality >= profileBefore.quality ? 'success' : 'warning');

      // Offer recipe recording
      const shouldRecord = confirm('清洗完成！是否将这些规则录制为可复用配方？');
      if (shouldRecord) {
        const enabledRules = this.rulesPanel.getRules().filter(r => r.enabled !== false);
        await this.recipeManager.offerRecording(enabledRules, ds);
      }
    } catch (err) {
      hideLoading();
      if (err.message === 'STALE_TASK' || err.message === 'CANCELLED') return;
      toast('执行失败: ' + err.message, 'error');
    }
  }

  /* ============================================================
     Undo / Redo (per-dataset history stacks)
     ============================================================ */
  _pushHistory() {
    const ds = this.getActiveDataset();
    if (!ds) return;

    // Initialize per-dataset history if needed
    if (!ds.history) ds.history = [];
    if (ds.historyIdx == null) ds.historyIdx = -1;

    // If we undid some steps and now push, truncate the "future" entries
    if (ds.historyIdx < ds.history.length - 1) {
      ds.history = ds.history.slice(0, ds.historyIdx + 1);
    }

    ds.history.push({
      headers: ds.headers.slice(),
      rows: ds.rows.map(r => r.slice()),
      profile: deepClone(ds.profile),
      rulesSnapshot: deepClone(this.rulesPanel.getRules()),
    });

    if (ds.history.length > this.maxHistory) ds.history.shift();
    ds.historyIdx = ds.history.length - 1;
    this._updateUndoRedoButtons();
  }

  undo() {
    const ds = this.getActiveDataset();
    if (!ds || !ds.history || ds.historyIdx <= 0) return;
    ds.historyIdx--;
    this._restoreHistory();
  }

  redo() {
    const ds = this.getActiveDataset();
    if (!ds || !ds.history || ds.historyIdx >= ds.history.length - 1) return;
    ds.historyIdx++;
    this._restoreHistory();
  }

  _restoreHistory() {
    const ds = this.getActiveDataset();
    if (!ds || !ds.history) return;
    const snap = ds.history[ds.historyIdx];
    if (!snap) return;

    // Restore into the CURRENT dataset only — never switch datasets
    ds.headers = snap.headers.slice();
    ds.rows = snap.rows.map(r => r.slice());
    ds.profile = deepClone(snap.profile);

    this.rulesPanel.setRules(snap.rulesSnapshot);
    this._renderDatasetList();
    this._renderActiveDataset();
    this._updateUndoRedoButtons();
  }

  _updateUndoRedoButtons() {
    const ds = this.getActiveDataset();
    const btnUndo = document.getElementById('btnUndo');
    const btnRedo = document.getElementById('btnRedo');
    if (!ds || !ds.history || ds.history.length === 0) {
      btnUndo.disabled = true;
      btnRedo.disabled = true;
      return;
    }
    btnUndo.disabled = (ds.historyIdx <= 0);
    btnRedo.disabled = (ds.historyIdx >= ds.history.length - 1);
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
      if (store._memoryStore.has(id)) {
        toast(`规则已暂存到内存 (IndexedDB 不可用): ${name}`, 'warning');
      } else {
        toast('保存失败: ' + err.message, 'error');
      }
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

  async exportRecipeJSON() {
    try {
      const recipes = await this.recipeManager.loadRecipes();
      if (recipes.length === 0) { toast('暂无配方可导出', 'warning'); return; }
      if (recipes.length === 1) {
        this.recipeManager.exportRecipeJSON(recipes[0]);
        toast('已导出配方', 'success');
        return;
      }
      const names = recipes.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
      const choice = prompt('选择要导出的配方:\n' + names);
      if (!choice) return;
      const idx = parseInt(choice) - 1;
      if (idx >= 0 && idx < recipes.length) {
        this.recipeManager.exportRecipeJSON(recipes[idx]);
        toast('已导出配方', 'success');
      }
    } catch (err) {
      toast('导出失败: ' + err.message, 'error');
    }
  }
}

/* Boot */
(async function init() {
  try {
    await store.open();
    if (!store.dbAvailable) {
      // Defer toast until after App constructor builds the toast container
      setTimeout(() => toast('IndexedDB 不可用，规则将仅在内存中保存', 'warning', 5000), 100);
    }
  } catch (e) {
    console.warn('IndexedDB init failed:', e);
    setTimeout(() => toast('存储初始化失败，使用内存模式', 'warning', 5000), 100);
  }
  window.app = new App();
})();
