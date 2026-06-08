/* worker-bridge.js — Promise-based Web Worker communication */

class WorkerBridge {
  constructor(workerUrl) {
    this.worker = new Worker(workerUrl);
    this.pending = new Map();
    this.nextId = 1;

    this.worker.onmessage = (e) => {
      const { id, ...data } = e.data;
      const handlers = this.pending.get(id);
      if (handlers) {
        this.pending.delete(id);
        if (data.success) handlers.resolve(data);
        else handlers.reject(new Error(data.error || 'Worker error'));
      }
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
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ task, id, payload });
    });
  }

  parseCSV(text, config) { return this.send('parse', { text, config }); }
  profile(headers, rows) { return this.send('profile', { headers, rows }); }
  executeRules(headers, rows, rules, allDatasets) { return this.send('executeRules', { headers, rows, rules, allDatasets }); }
  terminate() { this.worker.terminate(); }
}
