/* worker-bridge.js — Promise-based Web Worker communication with dual-axis task versioning
 *
 * Two independent version axes protect against race conditions:
 *   taskVersion    — bumped on new imports / rule executions (global invalidation)
 *   datasetVersion — bumped on active dataset switch (per-context invalidation)
 *
 * Every send() is stamped with BOTH versions at time of dispatch.
 * On receipt, a message is rejected as STALE_TASK if either version
 * has advanced, preventing stale results from being applied to the
 * wrong dataset or after a newer operation has started.
 */

class WorkerBridge {
  constructor(workerUrl) {
    this.worker = new Worker(workerUrl);
    this.pending = new Map();
    this.nextId = 1;
    this.currentTaskVersion = 0;
    this.currentDatasetVersion = 0;

    this.worker.onmessage = (e) => {
      const { id, ...data } = e.data;
      const handlers = this.pending.get(id);
      if (!handlers) return;

      this.pending.delete(id);

      // Dual-axis staleness check:
      // Reject if the task version has advanced (new import/execution started)
      if (handlers.taskVersion !== null &&
          handlers.taskVersion < this.currentTaskVersion) {
        handlers.reject(new Error('STALE_TASK'));
        return;
      }
      // Reject if the dataset version has advanced (user switched datasets)
      if (handlers.datasetVersion !== null &&
          handlers.datasetVersion < this.currentDatasetVersion) {
        handlers.reject(new Error('STALE_TASK'));
        return;
      }

      if (data.success) handlers.resolve(data);
      else handlers.reject(new Error(data.error || 'Worker error'));
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
   * Start a new task version. All pending versioned tasks with a lower
   * taskVersion are rejected with Error('STALE_TASK').
   * Call this when starting a new import or rule execution batch.
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
   * Bump the dataset version. All pending tasks with a lower datasetVersion
   * are rejected with Error('STALE_TASK').
   * Call this when the active dataset changes (user clicks a different
   * dataset in the sidebar), so that in-flight fingerprint computations,
   * match operations, and recipe replays for the old dataset are discarded.
   * Returns the new version number.
   */
  bumpDatasetVersion() {
    this.currentDatasetVersion++;
    const v = this.currentDatasetVersion;
    for (const [id, h] of this.pending) {
      if (h.datasetVersion !== null && h.datasetVersion < v) {
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
   * Cancel all pending tasks that belong to a specific dataset version.
   */
  cancelByDatasetVersion(dv) {
    for (const [id, h] of this.pending) {
      if (h.datasetVersion === dv) {
        h.reject(new Error('CANCELLED'));
        this.pending.delete(id);
      }
    }
  }

  /**
   * Send a versioned task to the worker. The returned Promise is stamped
   * with BOTH the current taskVersion and datasetVersion and will be
   * rejected if either version advances before it resolves.
   */
  send(task, payload) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve,
        reject,
        taskVersion: this.currentTaskVersion,
        datasetVersion: this.currentDatasetVersion,
      });
      this.worker.postMessage({ task, id, payload });
    });
  }

  /**
   * Send a task that should NOT be affected by task versioning
   * (e.g. operations that must always complete regardless of new imports).
   * Still subject to datasetVersion staleness check — switching datasets
   * invalidates operations bound to the previous active dataset.
   */
  sendExemptFromTaskVersion(task, payload) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve,
        reject,
        taskVersion: null,          // exempt from task-version stale checks
        datasetVersion: this.currentDatasetVersion, // still dataset-scoped
      });
      this.worker.postMessage({ task, id, payload });
    });
  }

  /**
   * Send a fully unversioned task — exempt from BOTH task and dataset
   * version checks. Use sparingly, only for operations that are truly
   * independent of dataset context.
   */
  sendUnversioned(task, payload) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve,
        reject,
        taskVersion: null,
        datasetVersion: null,
      });
      this.worker.postMessage({ task, id, payload });
    });
  }

  /* ---- Convenience methods (all versioned) ---- */

  parseCSV(text, config) { return this.send('parse', { text, config }); }
  profile(headers, rows) { return this.send('profile', { headers, rows }); }
  executeRules(headers, rows, rules, allDatasets) {
    return this.send('executeRules', { headers, rows, rules, allDatasets });
  }
  executeRecipeStep(headers, rows, stepConfig, allDatasets) {
    return this.send('executeRecipeStep', { headers, rows, stepConfig, allDatasets });
  }

  /**
   * Compute fingerprints — NOW VERSIONED. Stale fingerprint computations
   * are discarded when the user switches datasets, preventing wrong-column
   * operations on the new dataset.
   */
  computeFingerprints(headers, rows, profile) {
    return this.send('computeFingerprints', { headers, rows, profile });
  }

  /**
   * Match fingerprints — NOW VERSIONED. Stale match results are discarded
   * when the user switches datasets.
   */
  matchFingerprints(sourceFingerprints, targetHeaders, targetRows, targetProfile) {
    return this.send('matchFingerprints', {
      sourceFingerprints, targetHeaders, targetRows, targetProfile
    });
  }

  terminate() { this.worker.terminate(); }
}
