/* worker-bridge.js — Promise-based Web Worker communication with epoch-based cancellation */

class WorkerBridge {
  constructor(workerUrl) {
    this.worker = new Worker(workerUrl);
    this.pending = new Map();
    this.nextId = 1;
    this.epoch = 0;

    this.worker.onmessage = (e) => {
      const { id, ...data } = e.data;
      const handlers = this.pending.get(id);
      if (!handlers) return;
      this.pending.delete(id);

      // Discard stale responses from a previous epoch
      if (handlers.epoch !== this.epoch) {
        handlers.reject(new CancelledError('Stale worker response (epoch mismatch)'));
        return;
      }

      if (data.success) handlers.resolve(data);
      else handlers.reject(new Error(data.error || 'Worker error'));
    };

    this.worker.onerror = (e) => {
      console.error('Worker error:', e);
      for (const [, handlers] of this.pending) handlers.reject(new Error(e.message || 'Worker error'));
      this.pending.clear();
    };
  }

  send(task, payload) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, epoch: this.epoch });
      this.worker.postMessage({ task, id, payload });
    });
  }

  /** Increment epoch and reject all in-flight requests as cancelled */
  cancelAll() {
    this.epoch++;
    for (const [id, handlers] of this.pending) {
      handlers.reject(new CancelledError('Task cancelled by new operation'));
    }
    this.pending.clear();
  }

  /** Get the current epoch for stale-check after await */
  currentEpoch() {
    return this.epoch;
  }

  parseCSV(text, config) { return this.send('parse', { text, config }); }
  profile(headers, rows) { return this.send('profile', { headers, rows }); }
  executeRules(headers, rows, rules, allDatasets) { return this.send('executeRules', { headers, rows, rules, allDatasets }); }
  terminate() { this.worker.terminate(); }
}
