/* store.js — IndexedDB storage for rules and datasets */

const DB_NAME = 'CSVDataCleaner';
const DB_VERSION = 1;

class Store {
  constructor() { this.db = null; }

  async open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('rules')) db.createObjectStore('rules', { keyPath: 'id' });
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
      req.onerror = () => reject(new Error('Failed to open IndexedDB'));
    });
  }

  async saveRules(id, name, rules) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('rules', 'readwrite');
      tx.objectStore('rules').put({ id, name, rules, savedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('Failed to save rules'));
    });
  }

  async listRules() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('rules', 'readonly');
      const req = tx.objectStore('rules').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(new Error('Failed to list rules'));
    });
  }

  async deleteRules(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('rules', 'readwrite');
      tx.objectStore('rules').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('Failed to delete rules'));
    });
  }
}

const store = new Store();
