/* ============================================================
   db.js  –  IndexedDB wrapper for rule persistence
   ============================================================ */

const DB = (() => {
  const DB_NAME = "CSVCleanerDB";
  const DB_VERSION = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("ruleSets")) {
          db.createObjectStore("ruleSets", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("history")) {
          db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return _db.transaction(store, mode).objectStore(store);
  }

  function promisify(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  }

  /* ---- Rule Sets ---- */
  async function saveRuleSet(ruleSet) {
    await open();
    ruleSet.id = ruleSet.id || "rs_" + Date.now();
    ruleSet.updatedAt = Date.now();
    return promisify(tx("ruleSets", "readwrite").put(ruleSet));
  }

  async function getRuleSet(id) {
    await open();
    return promisify(tx("ruleSets", "readonly").get(id));
  }

  async function listRuleSets() {
    await open();
    return promisify(tx("ruleSets", "readonly").getAll());
  }

  async function deleteRuleSet(id) {
    await open();
    return promisify(tx("ruleSets", "readwrite").delete(id));
  }

  /* ---- Export / Import ---- */
  async function exportRuleSetsJSON() {
    const sets = await listRuleSets();
    return JSON.stringify(sets, null, 2);
  }

  async function importRuleSetsJSON(json) {
    const sets = JSON.parse(json);
    await open();
    const store = tx("ruleSets", "readwrite");
    for (const rs of sets) {
      store.put(rs);
    }
    return new Promise((res, rej) => {
      store.transaction.oncomplete = () => res(sets.length);
      store.transaction.onerror = () => rej(store.transaction.error);
    });
  }

  return { open, saveRuleSet, getRuleSet, listRuleSets, deleteRuleSet, exportRuleSetsJSON, importRuleSetsJSON };
})();
