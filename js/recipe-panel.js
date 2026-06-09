/* recipe-panel.js — Recipe list UI, match preview, step preview, and replay control */

class RecipePanel {
  constructor(app) {
    this.app = app;
    this.container = document.getElementById('recipesContent');
    this.modal = document.getElementById('ruleModal');
    this.modalTitle = document.getElementById('modalTitle');
    this.modalBody = document.getElementById('modalBody');
    this.modalConfirm = document.getElementById('modalConfirm');
    this.modalCancel = document.getElementById('modalCancel');
    this.modalCloseBtn = this.modal.querySelector('.modal-close');
    this.modalBackdrop = this.modal.querySelector('.modal-backdrop');
    this.recipes = [];
    this._pendingRecipe = null;
    this._pendingMappings = null;
    this._columnMap = null;
    this._boundDatasetName = null;
    this._currentStepMode = 'all'; // 'all' or 'step'

    this.modalCancel.addEventListener('click', () => this._hideModal());
    this.modalCloseBtn.addEventListener('click', () => this._hideModal());
    this.modalBackdrop.addEventListener('click', () => this._hideModal());
  }

  onDatasetChanged(oldName, newName) {
    if (this._boundDatasetName && this._boundDatasetName !== newName) {
      this._pendingRecipe = null;
      this._pendingMappings = null;
      this._boundDatasetName = null;
      if (this.modal.style.display === 'flex') {
        this._hideModal();
        toast('数据集已切换，方案操作已取消', 'warning');
      }
    }
  }

  async render() {
    try {
      this.recipes = await store.listRecipes();
    } catch (e) {
      this.recipes = [];
    }

    if (this.recipes.length === 0) {
      this.container.innerHTML = `
        <div class="recipe-toolbar">
          <button id="btnImportRecipe" class="btn-sm">从 JSON 导入</button>
          <span class="text-muted" style="margin-left:auto">执行清洗规则后可保存为可复用的清洗方案</span>
        </div>
        <div id="recipeList" class="recipe-list"></div>`;
      this._bindToolbarEvents();
      return;
    }

    let html = `<div class="recipe-toolbar">
      <button id="btnImportRecipe" class="btn-sm">从 JSON 导入</button>
      <button id="btnExportAllRecipes" class="btn-sm" style="margin-left:6px">导出所有方案</button>
      <span class="text-muted" style="margin-left:auto">${this.recipes.length} 个方案</span>
    </div>
    <div id="recipeList" class="recipe-list">`;

    for (const recipe of this.recipes) {
      const stepCount = recipe.steps ? recipe.steps.length : 0;
      const fpCount = recipe.sourceInfo && recipe.sourceInfo.fingerprints ? recipe.sourceInfo.fingerprints.length : 0;
      const created = new Date(recipe.createdAt).toLocaleDateString('zh-CN');
      const updated = recipe.updatedAt ? new Date(recipe.updatedAt).toLocaleDateString('zh-CN') : created;
      const srcInfo = recipe.sourceInfo || {};

      html += `<div class="recipe-card" data-id="${escHtml(recipe.id)}">
        <div class="recipe-icon">RCP</div>
        <div class="recipe-info">
          <div class="recipe-name">${escHtml(recipe.name)}</div>
          <div class="recipe-meta">${stepCount} 步骤 · ${fpCount} 列指纹 · 创建于 ${created}</div>
          <div class="recipe-meta">来源: ${fmtNum(srcInfo.rowCount || 0)} 行 x ${srcInfo.columnCount || 0} 列 · 质量 ${srcInfo.qualityScore || '--'}</div>
        </div>
        <div class="recipe-actions">
          <button class="btn-sm btn-primary" data-action="apply" data-id="${escHtml(recipe.id)}">应用</button>
          <button class="btn-sm" data-action="preview" data-id="${escHtml(recipe.id)}">预览</button>
          <button class="btn-sm" data-action="export" data-id="${escHtml(recipe.id)}">导出</button>
          <button class="btn-sm btn-danger" data-action="delete" data-id="${escHtml(recipe.id)}">删除</button>
        </div>
      </div>`;
    }
    html += '</div>';
    this.container.innerHTML = html;
    this._bindToolbarEvents();
    this._bindListEvents();
  }

  _bindToolbarEvents() {
    const importBtn = document.getElementById('btnImportRecipe');
    if (importBtn) importBtn.addEventListener('click', () => document.getElementById('recipeFileInput').click());
    const exportAllBtn = document.getElementById('btnExportAllRecipes');
    if (exportAllBtn) exportAllBtn.addEventListener('click', () => this._exportAll());
  }

  _bindListEvents() {
    const list = document.getElementById('recipeList');
    if (!list) return;
    list.onclick = async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      switch (btn.dataset.action) {
        case 'apply': await this._applyRecipe(id); break;
        case 'preview': this._previewRecipe(id); break;
        case 'export': this._exportRecipe(id); break;
        case 'delete': await this._deleteRecipe(id); break;
      }
    };
  }

  /* --- Apply Recipe --- */
  async _applyRecipe(id) {
    const ds = this.app.getActiveDataset();
    if (!ds) { toast('请先导入目标 CSV 数据', 'warning'); return; }

    const boundDatasetName = this.app.activeDatasetName;
    this._boundDatasetName = boundDatasetName;

    const recipe = await store.getRecipe(id);
    if (!recipe) { toast('方案不存在', 'error'); return; }

    if (this.app.activeDatasetName !== boundDatasetName) {
      toast('数据集已切换，操作已取消', 'warning');
      return;
    }

    showLoading('正在分析列匹配...');
    try {
      const matchResult = await this.app.worker.matchFingerprints(
        recipe.sourceInfo.fingerprints,
        ds.headers, ds.rows, ds.profile,
        boundDatasetName
      );

      if (this.app.activeDatasetName !== boundDatasetName) {
        hideLoading();
        toast('数据集已切换，操作已取消', 'warning');
        return;
      }

      hideLoading();
      this._showMatchModal(recipe, matchResult);
    } catch (err) {
      hideLoading();
      if (err.message === 'STALE_TASK' || err.message === 'STALE_DATASET' || err.message === 'CANCELLED') {
        toast('数据集已切换，操作已取消', 'warning');
        return;
      }
      toast('列匹配失败: ' + err.message, 'error');
    }
  }

  _showMatchModal(recipe, matchResult) {
    this._pendingRecipe = recipe;
    this._pendingMappings = matchResult;

    const conflicts = matchResult.conflicts || [];
    const confColor = matchResult.overallConfidence >= 80 ? 'var(--success)' :
                      matchResult.overallConfidence >= 50 ? 'var(--warning)' : 'var(--danger)';

    let html = `<div class="match-preview">
      <div class="match-overall">
        <span>整体匹配置信度:</span>
        <span class="match-overall-score" style="color:${confColor};font-weight:700">${matchResult.overallConfidence}%</span>
        <div class="match-overall-bar"><div class="match-overall-fill" style="width:${matchResult.overallConfidence}%;background:${confColor}"></div></div>
      </div>
      <h4 style="margin:12px 0 8px;font-size:13px">列映射 (方案列 → 当前CSV列):</h4>`;

    for (const m of matchResult.mappings) {
      const statusClass = m.conflict ? 'match-conflict' : ('match-' + m.status);
      const options = m.candidates.map(c =>
        `<option value="${escHtml(c.colName)}" ${c.colName === m.targetColName ? 'selected' : ''}>${escHtml(c.colName)} (${c.score}%)</option>`
      ).join('');

      const conflictNote = m.conflict
        ? `<div class="match-warning">⚠ 多列映射到同一目标列，请修改</div>` : '';
      const candidatesNote = m.status === 'ambiguous'
        ? `<div class="match-hint">候选: ${m.candidates.slice(0, 3).map(c => c.colName + '(' + c.score + '%)').join(', ')}</div>` : '';
      const unmatchedNote = m.status === 'unmatched'
        ? `<div class="match-warning">⚠ 未找到匹配列，请手动选择或跳过</div>` : '';

      html += `<div class="match-row ${statusClass}" data-fp-id="${escHtml(m.sourceFP.id)}">
        <div class="match-source">${escHtml(m.sourceFP.originalName)}</div>
        <div class="match-arrow">→</div>
        <div class="match-target">
          <select class="match-select" data-fp-id="${escHtml(m.sourceFP.id)}">
            <option value="">-- 请选择 --</option>
            ${options}
          </select>
        </div>
        <div class="match-confidence" style="color:${confidenceColor(m.confidence)}">${m.confidence}%</div>
        <div class="match-notes">${conflictNote}${candidatesNote}${unmatchedNote}</div>
      </div>`;
    }

    // Cross-validate steps warning
    const crossSteps = recipe.steps.filter(s => s.ruleType === 'crossValidate');
    if (crossSteps.length > 0) {
      html += `<div class="match-warning" style="margin-top:8px">⚠ 跨表关联校验步骤需手动配置关联数据集</div>`;
    }

    html += `<div style="margin-top:12px;display:flex;gap:12px">
        <label><input type="checkbox" id="skipUnmatched" checked> 跳过无法匹配的步骤</label>
        <label><input type="checkbox" id="skipConflicting"> 跳过有冲突的步骤</label>
      </div>
    </div>`;

    this.modalTitle.textContent = '应用方案: ' + recipe.name;
    this.modalBody.innerHTML = html;
    this.modalConfirm.textContent = '预览步骤 →';
    this.modal.style.display = 'flex';

    // Bind select change events
    this.modalBody.querySelectorAll('.match-select').forEach(sel => {
      sel.addEventListener('change', () => this._updateMatchValidation());
    });

    this.modalConfirm.onclick = () => {
      const colMap = this._collectColumnMap();
      const skipUnmatched = document.getElementById('skipUnmatched').checked;
      const skipConflicting = document.getElementById('skipConflicting').checked;
      this._showStepPreview(colMap, skipUnmatched, skipConflicting);
    };

    this._updateMatchValidation();
  }

  _updateMatchValidation() {
    // Check for conflicts (multiple selects with same value)
    const selects = this.modalBody.querySelectorAll('.match-select');
    const used = new Map();
    let hasConflict = false;

    selects.forEach(sel => {
      const val = sel.value;
      if (!val) return;
      if (!used.has(val)) used.set(val, []);
      used.get(val).push(sel);
    });

    // Reset all row styles
    this.modalBody.querySelectorAll('.match-row').forEach(row => {
      row.classList.remove('match-conflict');
    });

    for (const [target, sels] of used) {
      if (sels.length > 1) {
        hasConflict = true;
        sels.forEach(sel => {
          sel.closest('.match-row').classList.add('match-conflict');
        });
      }
    }

    // Enable/disable confirm button
    this.modalConfirm.disabled = hasConflict;
  }

  _collectColumnMap() {
    const colMap = new Map();
    this.modalBody.querySelectorAll('.match-select').forEach(sel => {
      if (sel.value) colMap.set(sel.dataset.fpId, sel.value);
    });
    return colMap;
  }

  _showStepPreview(colMap, skipUnmatched, skipConflicting) {
    const recipe = this._pendingRecipe;

    // Build column map by name (fpId -> targetName, then build name->name)
    const nameMap = new Map();
    for (const fp of recipe.sourceInfo.fingerprints) {
      const targetName = colMap.get(fp.id);
      if (targetName) nameMap.set(fp.originalName, targetName);
    }

    // Prepare replay engine
    this.app.recipeReplay.prepare(recipe, nameMap, skipUnmatched, skipConflicting);

    // Build step preview UI
    let html = `<div class="step-preview" id="stepPreviewContainer">
      <div class="replay-controls">
        <button id="btnReplayAll" class="btn-primary btn-sm">▶ 执行全部</button>
        <button id="btnReplayStep" class="btn-sm">逐步执行</button>
        <button id="btnReplayPause" class="btn-sm" disabled>⏸ 暂停</button>
        <button id="btnReplayCancel" class="btn-sm btn-danger">取消</button>
        <div class="replay-progress"><div id="replayProgressFill" class="replay-progress-fill"></div></div>
        <span id="replayProgressText" class="replay-progress-text">0/${this.app.recipeReplay.resolvedSteps.length}</span>
      </div>
      <div class="step-list">`;

    for (const step of this.app.recipeReplay.resolvedSteps) {
      const stepMeta = RULE_META[step.ruleType] || { icon: '???', label: step.ruleType };
      const skipNote = step._skipReason ? `<span class="step-skip-reason">(${escHtml(step._skipReason)})</span>` : '';
      const crossWarn = step.ruleType === 'crossValidate' ? '<span class="step-cross-warn">⚠ 需手动配置</span>' : '';

      html += `<div class="step-preview-item step-pending" data-step-idx="${step.index}">
        <div class="step-idx">${step.index + 1}</div>
        <div class="step-info">
          <div class="step-name">[${stepMeta.icon}] ${escHtml(step.name || stepMeta.label)} ${skipNote} ${crossWarn}</div>
          <div class="step-mapping" id="stepMapping${step.index}"></div>
        </div>
        <div class="step-stats" id="stepStats${step.index}"></div>
      </div>`;
    }

    html += '</div></div>';

    this.modalTitle.textContent = '步骤预览与执行';
    this.modalBody.innerHTML = html;
    this.modalConfirm.style.display = 'none';
    this.modalCancel.textContent = '关闭';

    // Show column mapping info for each step
    for (const step of this.app.recipeReplay.resolvedSteps) {
      const mappingEl = document.getElementById('stepMapping' + step.index);
      if (!mappingEl) continue;
      const refs = step.columnRefs || [];
      if (refs.length === 0 && step.ruleType === 'trim') {
        mappingEl.textContent = '所有字段';
      } else if (refs.length > 0) {
        const parts = refs.map(ref => {
          const fp = recipe.sourceInfo.fingerprints.find(f => f.id === ref.fingerprintId);
          if (!fp) return '';
          const target = nameMap.get(fp.originalName) || '(未匹配)';
          return fp.originalName + ' → ' + target;
        });
        mappingEl.textContent = parts.filter(Boolean).join(', ');
      }
    }

    // Bind replay controls
    document.getElementById('btnReplayAll').addEventListener('click', () => this._replayAll());
    document.getElementById('btnReplayStep').addEventListener('click', () => this._replayNextStep());
    document.getElementById('btnReplayPause').addEventListener('click', () => this._replayPause());
    document.getElementById('btnReplayCancel').addEventListener('click', () => this._replayCancel());
  }

  async _replayAll() {
    if (this._boundDatasetName && this.app.activeDatasetName !== this._boundDatasetName) {
      toast('数据集已切换，无法执行方案', 'warning');
      this._hideModal();
      return;
    }

    const replay = this.app.recipeReplay;
    const ds = this.app.getActiveDataset();
    if (!ds) return;

    // Push pre-replay history anchor
    this.app._pushHistory();

    this._setReplayButtons('running');
    document.getElementById('btnReplayAll').disabled = true;
    document.getElementById('btnReplayStep').disabled = true;

    showLoading('正在执行清洗方案...');

    await replay.executeAll(
      (stepIdx, result) => this._onStepComplete(stepIdx, result),
      (stepIdx, total) => {
        const pct = Math.round((stepIdx + 1) / total * 100);
        const fill = document.getElementById('replayProgressFill');
        const text = document.getElementById('replayProgressText');
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = (stepIdx + 1) + '/' + total;
      }
    );

    hideLoading();
    this._setReplayButtons('complete');
    this.app._renderActiveDataset();
    toast('方案执行完成!', 'success');
  }

  async _replayNextStep() {
    if (this._boundDatasetName && this.app.activeDatasetName !== this._boundDatasetName) {
      toast('数据集已切换，无法执行方案', 'warning');
      this._hideModal();
      return;
    }

    const replay = this.app.recipeReplay;
    if (replay.state === 'idle' || replay.state === 'ready') {
      this.app._pushHistory();
    }

    document.getElementById('btnReplayStep').disabled = true;
    showLoading('执行步骤 ' + (replay.currentStepIdx + 2) + '...');

    const result = await replay.executeNextStep(
      (stepIdx, result) => this._onStepComplete(stepIdx, result)
    );

    hideLoading();

    const total = replay.resolvedSteps.length;
    const done = replay.currentStepIdx + 1;
    const pct = Math.round(done / total * 100);
    const fill = document.getElementById('replayProgressFill');
    const text = document.getElementById('replayProgressText');
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = done + '/' + total;

    if (replay.state === 'complete') {
      this._setReplayButtons('complete');
      this.app._renderActiveDataset();
      toast('方案执行完成!', 'success');
    } else {
      document.getElementById('btnReplayStep').disabled = false;
      this.app._renderActiveDataset();
    }
  }

  _replayPause() {
    const replay = this.app.recipeReplay;
    if (replay.state === 'running') {
      replay.pause();
      this._setReplayButtons('paused');
    } else if (replay.state === 'paused') {
      replay.resume();
      this._setReplayButtons('running');
    }
  }

  _replayCancel() {
    this.app.recipeReplay.cancel();
    this._hideModal();
    toast('方案执行已取消', 'warning');
  }

  _setReplayButtons(state) {
    const btnAll = document.getElementById('btnReplayAll');
    const btnStep = document.getElementById('btnReplayStep');
    const btnPause = document.getElementById('btnReplayPause');

    switch (state) {
      case 'running':
        if (btnAll) btnAll.disabled = true;
        if (btnStep) btnStep.disabled = true;
        if (btnPause) btnPause.disabled = false;
        break;
      case 'paused':
        if (btnPause) { btnPause.disabled = false; btnPause.textContent = '▶ 继续'; }
        if (btnStep) btnStep.disabled = false;
        break;
      case 'complete':
        if (btnAll) btnAll.disabled = true;
        if (btnStep) btnStep.disabled = true;
        if (btnPause) btnPause.disabled = true;
        break;
    }
  }

  _onStepComplete(stepIdx, result) {
    const stepEl = this.modalBody.querySelector(`.step-preview-item[data-step-idx="${stepIdx}"]`);
    if (!stepEl) return;

    stepEl.classList.remove('step-pending');
    if (result.status === 'ok') {
      stepEl.classList.add('step-done');
    } else if (result.status === 'skipped') {
      stepEl.classList.add('step-skipped');
    } else {
      stepEl.classList.add('step-error');
    }

    const statsEl = document.getElementById('stepStats' + stepIdx);
    if (statsEl) {
      if (result.status === 'skipped') {
        statsEl.innerHTML = `<span class="step-skipped-text">已跳过</span>`;
      } else {
        const deltaStr = result.qualityDelta > 0 ? '+' + result.qualityDelta :
                         result.qualityDelta < 0 ? String(result.qualityDelta) : '--';
        const deltaColor = result.qualityDelta >= 0 ? 'var(--success)' : 'var(--danger)';
        statsEl.innerHTML = `影响 ${fmtNum(result.affectedCount)} 行 · 质量 <span style="color:${deltaColor}">${deltaStr}</span>`;
      }
    }

    // Mark next step as active
    const nextEl = this.modalBody.querySelector(`.step-preview-item[data-step-idx="${stepIdx + 1}"]`);
    if (nextEl) nextEl.classList.add('step-active');
  }

  /* --- Preview Recipe (read-only) --- */
  _previewRecipe(id) {
    const recipe = this.recipes.find(r => r.id === id);
    if (!recipe) return;

    let html = `<div class="recipe-preview-detail">
      <h4>${escHtml(recipe.name)}</h4>
      <p class="text-muted" style="font-size:12px;margin:4px 0">来源: ${fmtNum(recipe.sourceInfo.rowCount || 0)} 行 x ${recipe.sourceInfo.columnCount || 0} 列 · 质量 ${recipe.sourceInfo.qualityScore || '--'}</p>
      <h4 style="margin:12px 0 6px;font-size:13px">步骤列表:</h4>`;

    for (const step of recipe.steps) {
      const meta = RULE_META[step.ruleType] || { icon: '???', label: step.ruleType };
      const stats = step.executionStats || {};
      html += `<div class="recipe-step-preview">
        <span class="step-num">${step.index + 1}</span>
        <span class="step-label">[${meta.icon}] ${escHtml(step.name || meta.label)}</span>
        ${stats.affectedCount != null ? `<span class="text-muted" style="font-size:11px;margin-left:auto">影响 ${fmtNum(stats.affectedCount)} 行</span>` : ''}
      </div>`;
    }

    html += `<h4 style="margin:12px 0 6px;font-size:13px">列指纹:</h4>`;
    for (const fp of (recipe.sourceInfo.fingerprints || [])) {
      html += `<div class="recipe-fp-preview">
        <span class="fp-name">${escHtml(fp.originalName)}</span>
        <span class="fp-type">${fp.type} (${fp.typeConfidence}%)</span>
        <span class="fp-samples">${(fp.sampleValues || []).slice(0, 3).map(v => escHtml(v)).join(', ')}</span>
      </div>`;
    }
    html += '</div>';

    this.modalTitle.textContent = '方案预览';
    this.modalBody.innerHTML = html;
    this.modalConfirm.textContent = '应用此方案';
    this.modalConfirm.style.display = '';
    this.modalConfirm.disabled = false;
    this.modal.style.display = 'flex';

    this.modalConfirm.onclick = () => {
      this._hideModal();
      this._applyRecipe(id);
    };
  }

  _exportRecipe(id) {
    const recipe = this.recipes.find(r => r.id === id);
    if (!recipe) return;
    const json = JSON.stringify({ version: 1, type: 'recipe', recipe }, null, 2);
    downloadFile(json, recipe.name + '_recipe.json', 'application/json');
    toast('已导出方案: ' + recipe.name, 'success');
  }

  _exportAll() {
    const json = JSON.stringify({ version: 1, type: 'recipes', recipes: this.recipes }, null, 2);
    downloadFile(json, 'cleaning_recipes.json', 'application/json');
    toast('已导出所有方案', 'success');
  }

  async _deleteRecipe(id) {
    if (!confirm('确定删除此方案？')) return;
    await store.deleteRecipe(id);
    toast('方案已删除', 'success');
    this.render();
  }

  _hideModal() {
    this.modal.style.display = 'none';
    this.modalConfirm.style.display = '';
    this.modalConfirm.textContent = '确定';
    this.modalConfirm.disabled = false;
    this.modalCancel.textContent = '取消';
    this._pendingRecipe = null;
    this._pendingMappings = null;
    this._boundDatasetName = null;
  }
}
