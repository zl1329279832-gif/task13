/* recipe-panel.js — Recipe tab UI: list, preview, playback controls */

class RecipePanel {
  constructor(app) {
    this.app = app;
    this.listEl = document.getElementById('recipeList');
    this.previewEl = document.getElementById('recipePreview');
    this.playbackEl = document.getElementById('recipePlayback');
    this._currentRecipe = null;
    this._currentMatches = null;

    document.getElementById('btnRecordRecipe').addEventListener('click', () => this._onRecord());
    document.getElementById('btnImportRecipe').addEventListener('click', () => {
      document.getElementById('recipeFileInput').click();
    });
    document.getElementById('recipeFileInput').addEventListener('change', (e) => {
      if (e.target.files.length) this._onImportFile(e.target.files[0]);
      e.target.value = '';
    });
  }

  /* ============================================================
     Recipe List
     ============================================================ */

  async render() {
    let recipes;
    try {
      recipes = await this.app.recipeManager.loadRecipes();
    } catch (e) {
      recipes = [];
    }

    if (recipes.length === 0) {
      this.listEl.innerHTML = '<div class="recipe-empty">暂无保存的配方<br>在清洗规则 Tab 执行规则后可录制配方</div>';
      document.getElementById('btnExportRecipe').disabled = true;
      return;
    }

    document.getElementById('btnExportRecipe').disabled = false;
    let html = '';
    for (const recipe of recipes) {
      const date = new Date(recipe.updatedAt || recipe.createdAt).toLocaleString();
      const stepCount = recipe.steps ? recipe.steps.length : 0;
      const src = recipe.sourceInfo || {};
      html += `<div class="recipe-card" data-id="${escHtml(recipe.id)}">
        <div class="rc-icon">R</div>
        <div class="rc-info">
          <div class="rc-name">${escHtml(recipe.name)}</div>
          <div class="rc-meta">${stepCount} 步 | 源: ${escHtml(src.fileName || '?')} (${fmtNum(src.rowCount || 0)} 行 x ${src.columnCount || 0} 列) | ${date}</div>
        </div>
        <div class="rc-actions">
          <button class="btn-primary btn-sm" data-action="apply" data-id="${escHtml(recipe.id)}">应用</button>
          <button class="btn-sm" data-action="export" data-id="${escHtml(recipe.id)}">导出</button>
          <button class="btn-sm btn-danger" data-action="delete" data-id="${escHtml(recipe.id)}">删除</button>
        </div>
      </div>`;
    }
    this.listEl.innerHTML = html;

    this.listEl.onclick = async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      switch (btn.dataset.action) {
        case 'apply': await this._onApply(id); break;
        case 'export': await this._onExport(id); break;
        case 'delete': await this._onDelete(id); break;
      }
    };
  }

  /* ============================================================
     Preview Panel — fingerprint matching + conflict alerts
     ============================================================ */

  async _onApply(id) {
    const ds = this.app.getActiveDataset();
    if (!ds) { toast('请先导入数据集', 'warning'); return; }

    let recipe;
    try {
      recipe = await store.getRecipe(id);
    } catch (e) {
      toast('加载配方失败', 'error'); return;
    }
    if (!recipe) { toast('配方未找到', 'error'); return; }

    this._currentRecipe = recipe;
    const matches = this.app.recipeManager.matchFingerprints(recipe, ds);
    this._currentMatches = matches;

    this.showPreview(recipe, matches);
  }

  showPreview(recipe, matches) {
    this.previewEl.style.display = '';
    this.playbackEl.style.display = 'none';

    const hasMissing = matches.some(m => m.matchType === 'missing');
    const hasConflicts = matches.some(m => m.conflicts.length > 0);
    const hasAmbiguous = matches.some(m => m.matchType === 'ambiguous');

    // Build conflict alerts
    let alertsHtml = '';
    if (hasMissing) {
      const missing = matches.filter(m => m.matchType === 'missing').map(m => m.recipeColName);
      alertsHtml += `<div class="conflict-alert conflict-error">缺失列: ${missing.map(n => '"' + escHtml(n) + '"').join(', ')}。这些步骤将被跳过。</div>`;
    }
    if (hasAmbiguous) {
      alertsHtml += `<div class="conflict-alert">存在歧义匹配，请在下方手动确认列对应关系。</div>`;
    }
    if (hasConflicts && !hasMissing) {
      alertsHtml += `<div class="conflict-alert">部分列存在类型或分布差异，应用后可能产生不同结果。</div>`;
    }

    // Match table
    let tableHtml = `<table class="match-table">
      <thead><tr><th>配方列</th><th>匹配目标列</th><th>匹配方式</th><th>置信度</th><th>冲突</th></tr></thead><tbody>`;

    const ds = this.app.getActiveDataset();
    const targetCols = ds ? ds.headers : [];

    for (const m of matches) {
      const matchClass = 'match-' + m.matchType;
      const matchLabel = { exact: '精确', fuzzy_name: '名称相似', type_match: '类型匹配', ambiguous: '歧义', missing: '缺失' }[m.matchType] || m.matchType;

      let targetCell;
      if (m.matchType === 'ambiguous' || m.matchType === 'missing') {
        const opts = targetCols.map(c =>
          `<option value="${escHtml(c)}" ${c === m.matchedColName ? 'selected' : ''}>${escHtml(c)}</option>`
        ).join('');
        targetCell = `<select class="match-override" data-recipe-col="${escHtml(m.recipeColName)}">
          <option value="">-- 不匹配 --</option>${opts}</select>`;
      } else {
        targetCell = escHtml(m.matchedColName || '-');
      }

      const conflictText = m.conflicts.length > 0
        ? m.conflicts.map(c => escHtml(c.detail)).join('; ')
        : '-';

      tableHtml += `<tr>
        <td>${escHtml(m.recipeColName)}</td>
        <td>${targetCell}</td>
        <td class="${matchClass}">${matchLabel}</td>
        <td class="match-conf">${m.confidence}%</td>
        <td style="font-size:11px">${conflictText}</td>
      </tr>`;
    }
    tableHtml += '</tbody></table>';

    // Step preview list
    let stepsHtml = '<div class="step-preview-list"><h4>配方步骤预览</h4>';
    for (const step of recipe.steps) {
      const meta = RULE_META[step.rule.type] || { icon: '?', label: step.rule.type };
      stepsHtml += `<div class="step-preview-item">
        <span class="sp-order">${step.order + 1}</span>
        <span class="sp-type">${meta.icon}</span>
        <span class="sp-desc">${escHtml(step.description || step.rule.name || meta.label)}</span>
        <span class="sp-cols">${step.columnRefs.map(c => escHtml(c)).join(', ')}</span>
      </div>`;
    }
    stepsHtml += '</div>';

    this.previewEl.innerHTML = `
      <h4>配方预览: ${escHtml(recipe.name)}</h4>
      ${alertsHtml}
      ${tableHtml}
      ${stepsHtml}
      <div class="preview-actions">
        <button class="btn-secondary" id="btnPreviewCancel">取消</button>
        <button class="btn-primary" id="btnPreviewStart" ${hasMissing && matches.every(m => m.matchType === 'missing') ? 'disabled' : ''}>开始执行</button>
        <button class="btn-secondary" id="btnPreviewStepMode">逐步执行</button>
      </div>`;

    document.getElementById('btnPreviewCancel').onclick = () => this.hidePreview();
    document.getElementById('btnPreviewStart').onclick = () => this._startPlayback(false);
    document.getElementById('btnPreviewStepMode').onclick = () => this._startPlayback(true);
  }

  hidePreview() {
    this.previewEl.style.display = 'none';
    this._currentRecipe = null;
    this._currentMatches = null;
  }

  _buildColumnMapping() {
    const mapping = {};
    if (!this._currentMatches) return mapping;

    for (const m of this._currentMatches) {
      // Check for user override
      const overrideEl = this.previewEl.querySelector(`.match-override[data-recipe-col="${m.recipeColName}"]`);
      if (overrideEl && overrideEl.value) {
        mapping[m.recipeColName] = overrideEl.value;
      } else if (m.matchedColName) {
        mapping[m.recipeColName] = m.matchedColName;
      }
    }
    return mapping;
  }

  async _startPlayback(stepMode) {
    const recipe = this._currentRecipe;
    if (!recipe) return;

    const mapping = this._buildColumnMapping();
    this.hidePreview();

    const player = this.app.recipePlayer;
    await player.start(recipe, mapping);

    if (!stepMode) {
      await player.runAll();
    }
    // In step mode, player is in 'paused' state; user advances via buttons
  }

  /* ============================================================
     Playback Panel
     ============================================================ */

  showPlayback(state) {
    this.playbackEl.style.display = '';
    this.previewEl.style.display = 'none';
    this.updatePlayback(state);
  }

  updatePlayback(state) {
    if (!state || state.status === 'idle') {
      this.playbackEl.style.display = 'none';
      return;
    }

    this.playbackEl.style.display = '';
    const progress = state.totalSteps > 0
      ? Math.round(((state.currentStepIndex + 1) / state.totalSteps) * 100)
      : 0;

    const statusLabels = {
      running: '执行中...',
      paused: '已暂停',
      completed: '已完成',
      stopped: '已停止'
    };
    const statusLabel = statusLabels[state.status] || state.status;

    // Current step info
    let currentStepHtml = '';
    if (state.currentStepIndex >= 0 && state.currentStepIndex < state.totalSteps) {
      const step = state.rewrittenSteps[state.currentStepIndex];
      const meta = RULE_META[step.rule.type] || { icon: '?', label: step.rule.type };
      currentStepHtml = `<div class="playback-current">
        <div class="pc-title">步骤 ${state.currentStepIndex + 1}: [${meta.icon}] ${escHtml(step.description || step.rule.name || meta.label)}</div>
        <div class="pc-detail">影响列: ${step.columnRefs.map(c => escHtml(c)).join(', ')}</div>
      </div>`;
    }

    // Aggregate metrics
    let totalAffected = 0;
    let firstQuality = null, lastQuality = null;
    for (const sr of state.stepResults) {
      totalAffected += sr.affectedCount || 0;
      if (firstQuality === null && sr.qualityBefore) firstQuality = sr.qualityBefore;
      if (sr.qualityAfter) lastQuality = sr.qualityAfter;
    }
    const qualityDelta = (firstQuality !== null && lastQuality !== null) ? lastQuality - firstQuality : 0;
    const completedSteps = state.stepResults.filter(r => r.status === 'ok').length;

    const metricsHtml = `<div class="playback-metrics">
      <div class="pm-item"><div class="pm-value">${completedSteps}/${state.totalSteps}</div><div class="pm-label">已完成步骤</div></div>
      <div class="pm-item pm-warn"><div class="pm-value">${fmtNum(totalAffected)}</div><div class="pm-label">累计影响行</div></div>
      <div class="pm-item ${qualityDelta >= 0 ? 'pm-good' : 'pm-bad'}"><div class="pm-value">${qualityDelta >= 0 ? '+' : ''}${qualityDelta}</div><div class="pm-label">质量分变化</div></div>
      <div class="pm-item"><div class="pm-value">${lastQuality || '-'}</div><div class="pm-label">当前质量分</div></div>
    </div>`;

    // Control buttons
    const player = this.app.recipePlayer;
    const isPaused = state.status === 'paused';
    const isRunning = state.status === 'running';
    const isDone = state.status === 'completed' || state.status === 'stopped';

    let controlsHtml = '<div class="playback-controls">';
    if (isPaused) {
      controlsHtml += `<button class="btn-primary btn-sm" id="pbBtnNext">下一步</button>`;
      controlsHtml += `<button class="btn-primary btn-sm" id="pbBtnRunAll">继续全部</button>`;
      controlsHtml += `<button class="btn-sm" id="pbBtnSkip">跳过</button>`;
      controlsHtml += `<button class="btn-sm btn-danger" id="pbBtnStop">停止</button>`;
    } else if (isRunning) {
      controlsHtml += `<button class="btn-sm" id="pbBtnPause">暂停</button>`;
      controlsHtml += `<button class="btn-sm btn-danger" id="pbBtnStop">停止</button>`;
    }
    if (isDone || isPaused) {
      controlsHtml += `<span class="pc-sep"></span>`;
      controlsHtml += `<button class="btn-sm" id="pbBtnUndo" ${player.canUndo() ? '' : 'disabled'}>撤销</button>`;
      controlsHtml += `<button class="btn-sm" id="pbBtnRedo" ${player.canRedo() ? '' : 'disabled'}>重做</button>`;
    }
    if (isDone) {
      controlsHtml += `<span class="pc-sep"></span>`;
      controlsHtml += `<button class="btn-sm" id="pbBtnClose">关闭</button>`;
    }
    controlsHtml += '</div>';

    // Step execution log
    let logHtml = '<div class="playback-log"><h5>执行记录</h5>';
    for (let i = 0; i < state.stepResults.length; i++) {
      const sr = state.stepResults[i];
      const step = state.rewrittenSteps[i];
      const meta = step ? (RULE_META[step.rule.type] || { icon: '?' }) : { icon: '?' };
      const qDelta = sr.qualityAfter - sr.qualityBefore;
      const qClass = qDelta > 0 ? 'improved' : qDelta < 0 ? 'degraded' : '';
      const qText = sr.status === 'ok'
        ? `${sr.qualityBefore} -> ${sr.qualityAfter} (${qDelta >= 0 ? '+' : ''}${qDelta})`
        : '-';

      logHtml += `<div class="pb-step-log">
        <span class="psl-order">${i + 1}</span>
        <span class="psl-name">[${meta.icon}] ${escHtml(sr.log.ruleName || '')}</span>
        <span class="psl-affected">${sr.status === 'ok' ? fmtNum(sr.affectedCount) + ' 行' : ''}</span>
        <span class="psl-quality ${qClass}">${qText}</span>
        <span class="psl-status ${sr.status}">${sr.status === 'ok' ? '成功' : sr.status === 'skipped' ? '跳过' : '失败'}</span>
      </div>`;
    }
    logHtml += '</div>';

    this.playbackEl.innerHTML = `
      <div class="playback-header">
        <h4>配方回放 — ${statusLabel}</h4>
      </div>
      <div class="playback-progress">
        <div class="pp-bar"><div class="pp-fill" style="width:${progress}%"></div></div>
        <div class="pp-text">${state.currentStepIndex + 1} / ${state.totalSteps}</div>
      </div>
      ${currentStepHtml}
      ${metricsHtml}
      ${controlsHtml}
      ${logHtml}`;

    // Wire control buttons
    this._wirePlaybackButtons(player, isPaused, isRunning, isDone);
  }

  _wirePlaybackButtons(player, isPaused, isRunning, isDone) {
    const btn = (id) => document.getElementById(id);

    if (isPaused) {
      const nextBtn = btn('pbBtnNext');
      if (nextBtn) nextBtn.onclick = async () => {
        await player.executeNextStep();
        if (player.state.currentStepIndex >= player.state.totalSteps - 1) {
          player.state.status = 'completed';
          player._commitToAppHistory();
          player._updateUI();
          toast('配方回放完成', 'success');
        }
      };
      const runAllBtn = btn('pbBtnRunAll');
      if (runAllBtn) runAllBtn.onclick = () => player.runAll();
      const skipBtn = btn('pbBtnSkip');
      if (skipBtn) skipBtn.onclick = () => player.skip();
      const stopBtn = btn('pbBtnStop');
      if (stopBtn) stopBtn.onclick = () => {
        player.stop();
        toast('配方回放已停止', 'warning');
      };
    }
    if (isRunning) {
      const pauseBtn = btn('pbBtnPause');
      if (pauseBtn) pauseBtn.onclick = () => player.pause();
      const stopBtn = btn('pbBtnStop');
      if (stopBtn) stopBtn.onclick = () => {
        player.stop();
        toast('配方回放已停止', 'warning');
      };
    }
    if (isDone || isPaused) {
      const undoBtn = btn('pbBtnUndo');
      if (undoBtn) undoBtn.onclick = () => player.undo();
      const redoBtn = btn('pbBtnRedo');
      if (redoBtn) redoBtn.onclick = () => player.redo();
    }
    if (isDone) {
      const closeBtn = btn('pbBtnClose');
      if (closeBtn) closeBtn.onclick = () => {
        player.close();
        this.playbackEl.style.display = 'none';
      };
    }
  }

  /* ============================================================
     Actions
     ============================================================ */

  async _onRecord() {
    const ds = this.app.getActiveDataset();
    if (!ds) { toast('请先导入数据', 'warning'); return; }
    const rules = this.app.rulesPanel.getRules();
    if (rules.length === 0) { toast('请先添加清洗规则', 'warning'); return; }
    await this.app.recipeManager.offerRecording(rules, ds);
  }

  async _onExport(id) {
    try {
      const recipe = await store.getRecipe(id);
      if (recipe) {
        this.app.recipeManager.exportRecipeJSON(recipe);
        toast('配方已导出', 'success');
      }
    } catch (e) {
      toast('导出失败: ' + e.message, 'error');
    }
  }

  async _onDelete(id) {
    if (!confirm('确定删除此配方？')) return;
    try {
      await this.app.recipeManager.deleteRecipe(id);
      toast('配方已删除', 'success');
      this.render();
    } catch (e) {
      toast('删除失败: ' + e.message, 'error');
    }
  }

  async _onImportFile(file) {
    try {
      const text = await readFileAsText(file);
      const recipe = this.app.recipeManager.importRecipeJSON(text);
      await this.app.recipeManager.saveRecipe(recipe);
      toast(`已导入配方: ${recipe.name} (${recipe.steps.length} 步)`, 'success');
      this.render();
    } catch (err) {
      toast('导入失败: ' + err.message, 'error');
    }
  }
}
