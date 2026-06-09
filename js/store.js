/* store.js — IndexedDB storage for rules and datasets */

const DB_NAME = 'CSVDataCleaner';
const DB_VERSION = 1;

class Store {
  constructor() { this.db = null; }

  async open() {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        return reject(new Error('IndexedDB not available: ' + e.message));
      }
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('rules')) db.createObjectStore('rules', { keyPath: 'id' });
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        // Handle connection being closed by browser or other tabs
        this.db.onclose = () => { this.db = null; };
        this.db.onversionchange = () => { this.db.close(); this.db = null; };
        resolve();
      };
      req.onerror = () => reject(new Error('Failed to open IndexedDB'));
      req.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
    });
  }

  async _ensureDb() {
    if (this.db) return;
    await this.open();
  }

  async saveRules(id, name, rules) {
    await this._ensureDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction('rules', 'readwrite');
        tx.objectStore('rules').put({ id, name, rules, savedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new Error('Failed to save rules'));
        tx.onabort = () => reject(new Error('Transaction aborted while saving rules'));
      } catch (e) {
        // Stale db reference — reset and reject so caller can retry
        this.db = null;
        reject(new Error('Database connection lost: ' + e.message));
      }
    });
  }

  async listRules() {
    await this._ensureDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction('rules', 'readonly');
        const req = tx.objectStore('rules').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(new Error('Failed to list rules'));
        tx.onabort = () => reject(new Error('Transaction aborted while listing rules'));
      } catch (e) {
        this.db = null;
        reject(new Error('Database connection lost: ' + e.message));
      }
    });
  }

  async deleteRules(id) {
    await this._ensureDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction('rules', 'readwrite');
        tx.objectStore('rules').delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new Error('Failed to delete rules'));
        tx.onabort = () => reject(new Error('Transaction aborted while deleting rules'));
      } catch (e) {
        this.db = null;
        reject(new Error('Database connection lost: ' + e.message));
      }
    });
  }

  isAvailable() {
    return this.db !== null;
  }
}

const store = new Store();
