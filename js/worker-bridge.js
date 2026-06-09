/* worker-bridge.js — Promise-based Web Worker communication with task versioning */

class WorkerBridge {
  constructor(workerUrl) {
    this.worker = new Worker(workerUrl);
    this.pending = new Map();
    this.nextId = 1;
    this.currentTaskVersion = 0;
    this._isCurrentDatasetFn = null;

    this.worker.onmessage = (e) => {
      const { id, ...data } = e.data;
      const handlers = this.pending.get(id);
      if (handlers) {
        this.pending.delete(id);
        // Stale task check: if this message belongs to an outdated version, reject it
        if (handlers.taskVersion !== null &&
            handlers.taskVersion < this.currentTaskVersion) {
          handlers.reject(new Error('STALE_TASK'));
          return;
        }
        // Dataset identity check: reject if the active dataset changed
        if (handlers.datasetName != null &&
            this._isCurrentDatasetFn &&
            !this._isCurrentDatasetFn(handlers.datasetName)) {
          handlers.reject(new Error('STALE_DATASET'));
          return;
        }
        if (data.success) handlers.resolve(data);
        else handlers.reject(new Error(data.error || 'Worker error'));
      }
    };

    this.worker.onerror = (e) => {
      console.error('Worker error:', e);
      for (const [, handlers] of this.pending) {
        handlers.reject(new Error(e.message || 'Worker error'));
      }
      this.pending.clear();
    };
  }

  /**
   * Register a callback to validate whether a dataset name is still current.
   * @param {Function} fn - (datasetName) => boolean
   */
  setDatasetValidator(fn) {
    this._isCurrentDatasetFn = fn;
  }

  /**
   * Start a new task version. All pending tasks with a lower version
   * are rejected with Error('STALE_TASK').
   * Returns the new version number.
   */
  startNewTaskVersion() {
    this.currentTaskVersion++;
    const v = this.currentTaskVersion;
    for (const [id, h] of this.pending) {
      if (h.taskVersion !== null && h.taskVersion < v) {
        h.reject(new Error('STALE_TASK'));
        this.pending.delete(id);
      }
    }
    return v;
  }

  /**
   * Cancel all pending tasks with Error('CANCELLED').
   */
  cancelAll() {
    for (const [, h] of this.pending) {
      h.reject(new Error('CANCELLED'));
    }
    this.pending.clear();
  }

  /**
   * Cancel all pending tasks that belong to a specific task version.
   */
  cancelByTaskVersion(tv) {
    for (const [id, h] of this.pending) {
      if (h.taskVersion === tv) {
        h.reject(new Error('CANCELLED'));
        this.pending.delete(id);
      }
    }
  }

  /**
   * Send a task to the worker. The returned Promise is stamped with the
   * current task version and will be rejected if a newer version starts
   * before it resolves.
   */
  send(task, payload) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve,
        reject,
        taskVersion: this.currentTaskVersion,
      });
      this.worker.postMessage({ task, id, payload });
    });
  }

  /**
   * Send a task that should NOT be affected by task versioning
   * (e.g. profiling that must always complete). taskVersion is set to null.
   */
  sendUnversioned(task, payload) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve,
        reject,
        taskVersion: null, // exempt from stale checks
      });
      this.worker.postMessage({ task, id, payload });
    });
  }

  /**
   * Send a task stamped with both task version AND dataset identity.
   * Rejected with STALE_TASK if version changes, or STALE_DATASET
   * if the active dataset changes before the worker responds.
   */
  sendForDataset(task, payload, datasetName) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve,
        reject,
        taskVersion: this.currentTaskVersion,
        datasetName: datasetName || null,
      });
      this.worker.postMessage({ task, id, payload });
    });
  }

  parseCSV(text, config) { return this.send('parse', { text, config }); }
  profile(headers, rows) { return this.send('profile', { headers, rows }); }
  executeRules(headers, rows, rules, allDatasets) {
    return this.send('executeRules', { headers, rows, rules, allDatasets });
  }
  executeRecipeStep(headers, rows, stepConfig, allDatasets) {
    return this.send('executeRecipeStep', { headers, rows, stepConfig, allDatasets });
  }
  computeFingerprints(headers, rows, profile, datasetName) {
    return this.sendForDataset('computeFingerprints', { headers, rows, profile }, datasetName);
  }
  matchFingerprints(sourceFingerprints, targetHeaders, targetRows, targetProfile, datasetName) {
    return this.sendForDataset('matchFingerprints', {
      sourceFingerprints, targetHeaders, targetRows, targetProfile
    }, datasetName);
  }
  terminate() { this.worker.terminate(); }
}
