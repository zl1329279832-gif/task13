/* recipe-player.js — Step-by-step recipe playback state machine */

class RecipePlayer {
  constructor(app) {
    this.app = app;
    this._reset();
  }

  _reset() {
    this.state = {
      recipeId: null,
      status: 'idle',
      currentStepIndex: -1,
      totalSteps: 0,
      columnMapping: {},
      rewrittenSteps: [],
      stepResults: [],
      history: [],
      historyIdx: -1
    };
    this._resumeResolve = null;
    this._stopRequested = false;
    this._skipRequested = false;
  }

  getState() { return this.state; }
  isActive() { return this.state.status !== 'idle'; }

  /* ============================================================
     Start playback
     ============================================================ */

  async start(recipe, columnMapping) {
    this._reset();
    const mgr = this.app.recipeManager;

    // Rewrite all steps with column mapping
    const rewrittenSteps = recipe.steps.map(step => {
      const rewrittenRule = mgr.rewriteRuleColumns(step.rule, columnMapping);
      return { ...step, rule: rewrittenRule };
    });

    this.state.recipeId = recipe.id;
    this.state.status = 'paused';
    this.state.currentStepIndex = -1;
    this.state.totalSteps = rewrittenSteps.length;
    this.state.columnMapping = columnMapping;
    this.state.rewrittenSteps = rewrittenSteps;
    this._stopRequested = false;

    // Capture initial snapshot
    const ds = this.app.getActiveDataset();
    if (!ds) { toast('请先选择数据集', 'warning'); this._reset(); return; }

    this._pushSnapshot(ds);

    // Notify UI
    if (this.app.recipePanel) this.app.recipePanel.showPlayback(this.state);
    toast(`配方回放就绪，共 ${rewrittenSteps.length} 步`, 'success');
  }

  /* ============================================================
     Step execution
     ============================================================ */

  async runAll() {
    this.state.status = 'running';
    this._stopRequested = false;
    this._updateUI();

    while (this.state.currentStepIndex < this.state.totalSteps - 1) {
      if (this._stopRequested) break;

      // Check for pause
      if (this.state.status === 'paused') {
        await new Promise(resolve => { this._resumeResolve = resolve; });
        if (this._stopRequested) break;
      }

      if (this._skipRequested) {
        this._skipRequested = false;
        this._recordSkipped();
        continue;
      }

      await this.executeNextStep();

      if (this.state.status === 'paused') {
        this._updateUI();
        await new Promise(resolve => { this._resumeResolve = resolve; });
        if (this._stopRequested) break;
      }
    }

    if (this._stopRequested) {
      this.state.status = 'stopped';
    } else {
      this.state.status = 'completed';
    }

    this._commitToAppHistory();
    this._updateUI();

    const label = this.state.status === 'completed' ? '配方回放完成' : '配方回放已停止';
    const completedCount = this.state.stepResults.filter(r => r.status === 'ok').length;
    toast(`${label}，已执行 ${completedCount}/${this.state.totalSteps} 步`, 'success');
  }

  async executeNextStep() {
    const nextIdx = this.state.currentStepIndex + 1;
    if (nextIdx >= this.state.totalSteps) return;

    const step = this.state.rewrittenSteps[nextIdx];
    const ds = this.app.getActiveDataset();
    if (!ds) return;

    this.state.currentStepIndex = nextIdx;
    this._updateUI();

    showLoading(`执行步骤 ${nextIdx + 1}/${this.state.totalSteps}: ${step.description || step.rule.type}...`,
      nextIdx / this.state.totalSteps);

    try {
      const allDatasets = this.app.getAllDatasetsForWorker();
      const result = await this.app.worker.executeRecipeStep(
        ds.headers.slice(), ds.rows.map(r => r.slice()), step.rule, allDatasets
      );

      if (result.error) {
        this.state.stepResults.push({
          stepId: step.stepId,
          status: 'error',
          affectedCount: 0,
          qualityBefore: result.profileBefore.quality,
          qualityAfter: result.profileBefore.quality,
          error: result.error,
          log: { ruleType: step.rule.type, ruleName: step.description, affectedCount: 0, status: 'error', error: result.error }
        });
        hideLoading();
        this._updateUI();
        return;
      }

      // Update dataset
      ds.headers = result.headers;
      ds.rows = result.rows;
      ds.profile = result.profileAfter;

      // Push snapshot for undo
      this._pushSnapshot(ds);

      // Record step result
      this.state.stepResults.push({
        stepId: step.stepId,
        status: 'ok',
        affectedCount: result.affectedCount,
        qualityBefore: result.profileBefore.quality,
        qualityAfter: result.profileAfter.quality,
        log: {
          ruleType: step.rule.type,
          ruleName: step.description || step.rule.name || step.rule.type,
          affectedCount: result.affectedCount,
          changes: result.changes,
          affectedRows: result.affectedRows,
          status: 'ok'
        }
      });

      hideLoading();
      this.app._renderActiveDataset();
      this._updateUI();

    } catch (err) {
      hideLoading();
      if (err.message === 'STALE_TASK' || err.message === 'CANCELLED') return;
      this.state.stepResults.push({
        stepId: step.stepId,
        status: 'error',
        affectedCount: 0,
        qualityBefore: 0,
        qualityAfter: 0,
        error: err.message,
        log: { ruleType: step.rule.type, ruleName: step.description, affectedCount: 0, status: 'error', error: err.message }
      });
      this._updateUI();
    }
  }

  _recordSkipped() {
    const nextIdx = this.state.currentStepIndex + 1;
    if (nextIdx >= this.state.totalSteps) return;
    const step = this.state.rewrittenSteps[nextIdx];
    this.state.currentStepIndex = nextIdx;
    this.state.stepResults.push({
      stepId: step.stepId,
      status: 'skipped',
      affectedCount: 0,
      qualityBefore: 0,
      qualityAfter: 0,
      log: { ruleType: step.rule.type, ruleName: step.description, affectedCount: 0, status: 'skipped' }
    });
    this._updateUI();
  }

  /* ============================================================
     Playback controls
     ============================================================ */

  pause() {
    if (this.state.status === 'running') {
      this.state.status = 'paused';
      this._updateUI();
    }
  }

  resume() {
    if (this.state.status === 'paused') {
      this.state.status = 'running';
      if (this._resumeResolve) {
        this._resumeResolve();
        this._resumeResolve = null;
      }
      this._updateUI();
    }
  }

  skip() {
    this._skipRequested = true;
    if (this.state.status === 'paused') {
      this._recordSkipped();
      // If was paused, resolve to let loop continue
      if (this._resumeResolve) {
        this._resumeResolve();
        this._resumeResolve = null;
      }
    }
  }

  stop() {
    this._stopRequested = true;
    this.state.status = 'stopped';
    if (this._resumeResolve) {
      this._resumeResolve();
      this._resumeResolve = null;
    }
    this._updateUI();
  }

  /* ============================================================
     Per-step undo / redo
     ============================================================ */

  canUndo() {
    return this.state.historyIdx > 0 && (this.state.status === 'paused' || this.state.status === 'completed' || this.state.status === 'stopped');
  }

  canRedo() {
    return this.state.historyIdx < this.state.history.length - 1 && (this.state.status === 'paused' || this.state.status === 'completed' || this.state.status === 'stopped');
  }

  undo() {
    if (!this.canUndo()) return;
    this.state.historyIdx--;
    this.state.currentStepIndex--;
    if (this.state.stepResults.length > 0) this.state.stepResults.pop();
    this._restoreSnapshot();
    this._updateUI();
  }

  redo() {
    if (!this.canRedo()) return;
    // Re-execute the next step
    this.state.historyIdx++;
    this._restoreSnapshot();
    this._updateUI();
  }

  /* ============================================================
     Snapshot management
     ============================================================ */

  _pushSnapshot(ds) {
    // Truncate future if we undid some steps
    if (this.state.historyIdx < this.state.history.length - 1) {
      this.state.history = this.state.history.slice(0, this.state.historyIdx + 1);
    }
    this.state.history.push({
      headers: ds.headers.slice(),
      rows: ds.rows.map(r => r.slice()),
      profile: deepClone(ds.profile)
    });
    this.state.historyIdx = this.state.history.length - 1;
  }

  _restoreSnapshot() {
    const snap = this.state.history[this.state.historyIdx];
    if (!snap) return;
    const ds = this.app.getActiveDataset();
    if (!ds) return;
    ds.headers = snap.headers.slice();
    ds.rows = snap.rows.map(r => r.slice());
    ds.profile = deepClone(snap.profile);
    this.app._renderActiveDataset();
  }

  _commitToAppHistory() {
    this.app._pushHistory();
  }

  /* ============================================================
     Close / cleanup
     ============================================================ */

  close() {
    if (this.isActive() && this.state.status !== 'completed' && this.state.status !== 'stopped') {
      this.stop();
    }
    this._reset();
    this._updateUI();
  }

  _updateUI() {
    if (this.app.recipePanel) {
      this.app.recipePanel.updatePlayback(this.state);
    }
  }
}
