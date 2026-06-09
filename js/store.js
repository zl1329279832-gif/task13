/* store.js — IndexedDB storage for rules with in-memory fallback */

const DB_NAME = 'CSVDataCleaner';
const DB_VERSION = 3;

class Store {
  constructor() {
    this.db = null;
    this.dbAvailable = false;
    this._memoryStore = new Map();
  }

  async open() {
    if (typeof indexedDB === 'undefined') {
      console.warn('IndexedDB not available, using in-memory storage');
      this.dbAvailable = false;
      return;
    }
    try {
      this.db = await new Promise((resolve, reject) => {
        let req;
        try { req = indexedDB.open(DB_NAME, DB_VERSION); }
        catch (e) { reject(e); return; }

        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          const oldVersion = e.oldVersion;

          // v0 -> v1: create rules store
          if (oldVersion < 1 && !db.objectStoreNames.contains('rules')) {
            db.createObjectStore('rules', { keyPath: 'id' });
          }

          // v1 -> v2: add name index + validate existing data
          if (oldVersion < 2 && db.objectStoreNames.contains('rules')) {
            const store = e.target.transaction.objectStore('rules');
            if (!store.indexNames.contains('name')) {
              store.createIndex('name', 'name', { unique: false });
            }

            const cursorReq = store.openCursor();
            cursorReq.onsuccess = (ce) => {
              const cursor = ce.target.result;
              if (!cursor) return;
              const record = cursor.value;
              let needsUpdate = false;
              if (record.savedAt == null) { record.savedAt = Date.now(); needsUpdate = true; }
              if (!Array.isArray(record.rules)) { record.rules = []; needsUpdate = true; }
              if (record.name == null) { record.name = record.id || 'unnamed'; needsUpdate = true; }
              if (needsUpdate) cursor.update(record);
              cursor.continue();
            };
          }

          // v2 -> v3: add recipes store
          if (oldVersion < 3) {
            if (!db.objectStoreNames.contains('recipes')) {
              const recipeStore = db.createObjectStore('recipes', { keyPath: 'id' });
              recipeStore.createIndex('name', 'name', { unique: false });
              recipeStore.createIndex('updatedAt', 'updatedAt', { unique: false });
            }
          }
        };

        // Handle blocked: another tab has old version open
        // Instead of immediately failing, wait for old connections to close
        req.onblocked = () => {
          console.warn('IndexedDB upgrade blocked by another tab, waiting...');
          // Don't reject — let the user close the old tab.
          // Set a timeout so we don't wait forever (30s)
          setTimeout(() => {
            reject(new Error('IndexedDB upgrade timed out — please close other tabs with this app'));
          }, 30000);
        };

        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = () => reject(new Error('Failed to open IndexedDB'));
      });
      this.dbAvailable = true;
    } catch (err) {
      console.warn('IndexedDB unavailable:', err.message);
      this.dbAvailable = false;
      this.db = null;
    }
  }

  _safeTransaction(storeName, mode) {
    if (!this.db) throw new Error('Database not open');
    // Check if db connection is still valid (can throw if db was closed)
    try {
      const tx = this.db.transaction(storeName, mode);
      return tx;
    } catch (e) {
      this.dbAvailable = false;
      throw new Error('Database connection lost: ' + e.message);
    }
  }

  async saveRules(id, name, rules) {
    const record = { id, name, rules, savedAt: Date.now() };
    if (!this.dbAvailable) {
      this._memoryStore.set(id, record);
      return;
    }
    try {
      await new Promise((resolve, reject) => {
        const tx = this._safeTransaction('rules', 'readwrite');
        tx.objectStore('rules').put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => {
          const err = e.target.error;
          reject(new Error(
            err && err.name === 'QuotaExceededError'
              ? 'Storage quota exceeded'
              : 'Failed to save rules'
          ));
        };
      });
      // Also keep in memory as cache
      this._memoryStore.set(id, record);
    } catch (err) {
      // Fallback: save to memory even if IDB failed
      this._memoryStore.set(id, record);
      throw err;
    }
  }

  async listRules() {
    if (!this.dbAvailable) {
      return [...this._memoryStore.values()].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    }
    try {
      return await new Promise((resolve, reject) => {
        const tx = this._safeTransaction('rules', 'readonly');
        const req = tx.objectStore('rules').getAll();
        req.onsuccess = () => {
          const results = req.result || [];
          // Update memory cache
          this._memoryStore.clear();
          for (const r of results) this._memoryStore.set(r.id, r);
          resolve(results);
        };
        tx.onerror = () => reject(new Error('Failed to list rules'));
      });
    } catch (err) {
      // Fallback to memory cache
      return [...this._memoryStore.values()].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    }
  }

  async deleteRules(id) {
    this._memoryStore.delete(id);
    if (!this.dbAvailable) return;
    try {
      await new Promise((resolve, reject) => {
        const tx = this._safeTransaction('rules', 'readwrite');
        tx.objectStore('rules').delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new Error('Failed to delete rules'));
      });
    } catch (err) {
      console.warn('IDB delete failed:', err.message);
    }
  }

  async getRules(id) {
    if (!this.dbAvailable) return this._memoryStore.get(id) || null;
    try {
      return await new Promise((resolve, reject) => {
        const tx = this._safeTransaction('rules', 'readonly');
        const req = tx.objectStore('rules').get(id);
        req.onsuccess = () => resolve(req.result || null);
        tx.onerror = () => reject(new Error('Failed to get rules'));
      });
    } catch (err) {
      return this._memoryStore.get(id) || null;
    }
  }

  /* ---- Recipe CRUD (mirrors rules pattern) ---- */

  async saveRecipe(recipe) {
    recipe.updatedAt = Date.now();
    if (!this.dbAvailable) {
      this._memoryStore.set('recipe_' + recipe.id, recipe);
      return;
    }
    try {
      await new Promise((resolve, reject) => {
        const tx = this._safeTransaction('recipes', 'readwrite');
        tx.objectStore('recipes').put(recipe);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => {
          const err = e.target.error;
          reject(new Error(
            err && err.name === 'QuotaExceededError'
              ? 'Storage quota exceeded'
              : 'Failed to save recipe'
          ));
        };
      });
      this._memoryStore.set('recipe_' + recipe.id, recipe);
    } catch (err) {
      this._memoryStore.set('recipe_' + recipe.id, recipe);
      throw err;
    }
  }

  async listRecipes() {
    if (!this.dbAvailable) {
      return [...this._memoryStore.values()]
        .filter(v => v && v.steps)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    try {
      return await new Promise((resolve, reject) => {
        const tx = this._safeTransaction('recipes', 'readonly');
        const req = tx.objectStore('recipes').getAll();
        req.onsuccess = () => {
          const results = (req.result || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          for (const r of results) this._memoryStore.set('recipe_' + r.id, r);
          resolve(results);
        };
        tx.onerror = () => reject(new Error('Failed to list recipes'));
      });
    } catch (err) {
      return [...this._memoryStore.values()]
        .filter(v => v && v.steps)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
  }

  async getRecipe(id) {
    if (!this.dbAvailable) return this._memoryStore.get('recipe_' + id) || null;
    try {
      return await new Promise((resolve, reject) => {
        const tx = this._safeTransaction('recipes', 'readonly');
        const req = tx.objectStore('recipes').get(id);
        req.onsuccess = () => resolve(req.result || null);
        tx.onerror = () => reject(new Error('Failed to get recipe'));
      });
    } catch (err) {
      return this._memoryStore.get('recipe_' + id) || null;
    }
  }

  async deleteRecipe(id) {
    this._memoryStore.delete('recipe_' + id);
    if (!this.dbAvailable) return;
    try {
      await new Promise((resolve, reject) => {
        const tx = this._safeTransaction('recipes', 'readwrite');
        tx.objectStore('recipes').delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new Error('Failed to delete recipe'));
      });
    } catch (err) {
      console.warn('IDB recipe delete failed:', err.message);
    }
  }
}

const store = new Store();
