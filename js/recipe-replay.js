/* recipe-replay.js — Step-by-step recipe execution engine with undo integration */

class RecipeReplayEngine {
  constructor(app) {
    this.app = app;
    this.state = 'idle';       // idle | ready | running | paused | complete | error
    this.recipe = null;
    this.resolvedSteps = null;
    this.currentStepIdx = -1;
    this.stepResults = [];
    this._resumeResolve = null;
    this._cancelled = false;
    this._boundDatasetName = null;
  }

  /**
   * Prepare recipe for replay. Resolves column references using the column map.
   * @param {Object} recipe - Recipe object
   * @param {Map} columnMap - sourceColName -> targetColName
   * @param {boolean} skipUnmatched - skip steps with unresolved columns
   * @param {boolean} skipConflicting - skip steps with conflicts
   */
  prepare(recipe, columnMap, skipUnmatched, skipConflicting) {
    this.recipe = recipe;
    this.stepResults = [];
    this.currentStepIdx = -1;
    this._cancelled = false;
    this._boundDatasetName = this.app.activeDatasetName;

    this.resolvedSteps = recipe.steps.map((step, idx) => {
      const resolved = deepClone(step);
      resolved._skipReason = null;

      if (!step.enabled) {
        resolved._skipReason = 'disabled';
        return resolved;
      }

      // Resolve column references
      const unresolved = this._resolveColumnRefs(resolved.config, step.columnRefs || [], columnMap);

      if (unresolved.length > 0 && skipUnmatched) {
        resolved._skipReason = 'unmatched: ' + unresolved.join(', ');
      } else if (unresolved.length > 0) {
        resolved._skipReason = 'unmatched: ' + unresolved.join(', ');
      }

      return resolved;
    });

    // Mark conflicting steps if requested
    if (skipConflicting) {
      for (const step of this.resolvedSteps) {
        if (step._conflictStep) {
          step._skipReason = 'conflict';
        }
      }
    }

    this.state = 'ready';
  }

  _verifyDataset() {
    if (!this._boundDatasetName) return false;
    return this.app.activeDatasetName === this._boundDatasetName;
  }

  onDatasetChanged(oldName, newName) {
    if (this._boundDatasetName && this._boundDatasetName !== newName) {
      if (this.state === 'running' || this.state === 'paused' || this.state === 'ready') {
        this.cancel();
      }
      this._boundDatasetName = null;
    }
  }

  _resolveColumnRefs(config, columnRefs, colMap) {
    const unresolved = [];
    let columnsRemapped = false;
    for (const ref of columnRefs) {
      const fp = this.recipe.sourceInfo.fingerprints.find(f => f.id === ref.fingerprintId);
      if (!fp) continue;
      const targetCol = colMap.get(fp.originalName);
      if (!targetCol) {
        unresolved.push(fp.originalName);
        continue;
      }

      if (ref.configKey === 'column') {
        config.column = targetCol;
      } else if (ref.configKey === 'thisColumn') {
        config.thisColumn = targetCol;
      } else if (ref.configKey === 'columns[]' && !columnsRemapped) {
        if (config.columns) {
          config.columns = config.columns.map(c => colMap.get(c) || c);
          columnsRemapped = true;
        }
      } else if (ref.configKey.startsWith('mapping.')) {
        const oldKey = ref.configKey.slice('mapping.'.length);
        if (config.mapping && config.mapping[oldKey] !== undefined) {
          const val = config.mapping[oldKey];
          delete config.mapping[oldKey];
          config.mapping[targetCol] = val;
        }
      }
    }
    return unresolved;
  }

  /**
   * Execute all steps sequentially.
   * @param {Function} onStepComplete - (stepIdx, result) => void
   * @param {Function} onProgress - (stepIdx, totalSteps) => void
   */
  async executeAll(onStepComplete, onProgress) {
    this.state = 'running';
    this._cancelled = false;

    for (let i = 0; i < this.resolvedSteps.length; i++) {
      if (this._cancelled) { this.state = 'idle'; return; }
      if (!this._verifyDataset()) { this.state = 'idle'; return; }
      if (this.state === 'paused') {
        await this._waitForResume();
        if (this._cancelled) { this.state = 'idle'; return; }
        if (!this._verifyDataset()) { this.state = 'idle'; return; }
      }

      this.currentStepIdx = i;
      if (onProgress) onProgress(i, this.resolvedSteps.length);

      const result = await this._executeStep(i);
      this.stepResults.push(result);

      if (result.status === 'ok') {
        this.app._pushHistory();
        this.app._renderActiveDataset();
      }

      if (onStepComplete) onStepComplete(i, result);
    }

    this.state = 'complete';
  }

  /**
   * Execute just the next step (step-by-step mode).
   * @param {Function} onComplete - (stepIdx, result) => void
   */
  async executeNextStep(onComplete) {
    if (!this._verifyDataset()) {
      this.state = 'idle';
      return null;
    }

    const nextIdx = this.currentStepIdx + 1;
    if (nextIdx >= this.resolvedSteps.length) {
      this.state = 'complete';
      return null;
    }

    this.currentStepIdx = nextIdx;
    this.state = 'running';

    const result = await this._executeStep(nextIdx);
    this.stepResults.push(result);

    if (result.status === 'ok') {
      this.app._pushHistory();
      this.app._renderActiveDataset();
    }

    if (onComplete) onComplete(nextIdx, result);

    if (nextIdx >= this.resolvedSteps.length - 1) {
      this.state = 'complete';
    } else {
      this.state = 'paused';
    }

    return result;
  }

  async _executeStep(stepIdx) {
    if (!this._verifyDataset()) {
      return {
        index: stepIdx, status: 'cancelled',
        error: 'Dataset changed during replay',
        affectedCount: 0, changes: [],
        qualityBefore: 0, qualityAfter: 0, qualityDelta: 0,
      };
    }

    const step = this.resolvedSteps[stepIdx];
    const ds = this.app.getActiveDataset();
    if (!ds) return { index: stepIdx, status: 'error', error: 'No active dataset' };

    // Handle skipped steps
    if (step._skipReason) {
      return {
        index: stepIdx, status: 'skipped',
        error: null, affectedCount: 0,
        changes: [], qualityBefore: ds.profile ? ds.profile.quality : 0,
        qualityAfter: ds.profile ? ds.profile.quality : 0,
        qualityDelta: 0, skipReason: step._skipReason,
      };
    }

    const qualityBefore = ds.profile ? ds.profile.quality : 0;

    try {
      const result = await this.app.worker.executeRecipeStep(
        ds.headers.slice(),
        ds.rows.map(r => r.slice()),
        step.config,
        this.app.getAllDatasetsForWorker()
      );

      ds.headers = result.headers;
      ds.rows = result.rows;
      ds.profile = result.profileAfter;

      return {
        index: stepIdx,
        status: result.error ? 'error' : 'ok',
        error: result.error || null,
        affectedCount: result.affectedCount || 0,
        affectedRows: result.affectedRows || [],
        changes: (result.changes || []).slice(0, 50),
        qualityBefore,
        qualityAfter: result.profileAfter.quality,
        qualityDelta: result.profileAfter.quality - qualityBefore,
      };
    } catch (err) {
      if (err.message === 'STALE_TASK' || err.message === 'CANCELLED') {
        return { index: stepIdx, status: 'cancelled', error: err.message,
          affectedCount: 0, changes: [], qualityBefore, qualityAfter: qualityBefore, qualityDelta: 0 };
      }
      return { index: stepIdx, status: 'error', error: err.message,
        affectedCount: 0, changes: [], qualityBefore, qualityAfter: qualityBefore, qualityDelta: 0 };
    }
  }

  pause() { if (this.state === 'running') this.state = 'paused'; }
  resume() {
    if (this.state === 'paused') {
      this.state = 'running';
      if (this._resumeResolve) { this._resumeResolve(); this._resumeResolve = null; }
    }
  }
  cancel() {
    this._cancelled = true;
    this.state = 'idle';
    this._boundDatasetName = null;
    if (this._resumeResolve) { this._resumeResolve(); this._resumeResolve = null; }
  }
  _waitForResume() {
    return new Promise(resolve => { this._resumeResolve = resolve; });
  }
}
