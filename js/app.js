/* ============================================================
   app.js  –  Main application controller
   ============================================================ */

const App = (() => {
  /* ---- state ---- */
  const state = {
    datasets: {},          // { fileName: { headers, data, originalData, columnTypes, issues } }
    activeFile: null,
    rules: [],
    ruleCounter: 0,
    undoStack: [],
    redoStack: [],
    cleanedResult: null,
  };

  let worker = null;
  let msgId = 0;
  const pending = {};

  /* ---- Worker communication ---- */
  function initWorker() {
    worker = new Worker("js/csv-worker.js");
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = pending[id];
      if (p) { ok ? p.resolve(result) : p.reject(new Error(error)); delete pending[id]; }
    };
  }

  function callWorker(action, payload) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      pending[id] = { resolve, reject };
      worker.postMessage({ id, action, payload });
    });
  }

  /* ---- File loading ---- */
  async function loadFile(file) {
    UI.showProgress(`正在解析 ${file.name}...`);
    const text = await readFileText(file);
    const delimiter = detectDelimiter(text);
    const { headers, data } = await callWorker("parse", { text, delimiter });
    if (headers.length === 0) { UI.showError("文件为空或格式错误: " + file.name); return; }

    UI.showProgress("正在推断字段类型...");
    const columnTypes = await callWorker("inferTypes", { headers, data });

    UI.showProgress("正在检测数据问题...");
    const issues = await callWorker("detectIssues", { headers, data, columnTypes });

    state.datasets[file.name] = {
      headers, data, originalData: data.map(r => [...r]),
      columnTypes, issues, fileName: file.name
    };

    state.activeFile = file.name;
    state.undoStack = [];
    state.redoStack = [];
    state.cleanedResult = null;

    UI.renderFileList(Object.keys(state.datasets), state.activeFile);
    UI.renderDataPreview(headers, data, columnTypes, issues);
    UI.renderColumnInfo(headers, columnTypes);
    UI.renderIssuesSummary(issues, data.length);
    await refreshQuality();
    UI.hideProgress();
  }

  async function refreshQuality() {
    const ds = getActiveDS();
    if (!ds) return;
    const score = await callWorker("qualityScore", {
      headers: ds.headers, data: ds.data, columnTypes: ds.columnTypes
    });
    UI.renderQualityScore(score);
  }

  /* ---- Rule management ---- */
  function addRule(type, config) {
    const rule = {
      id: "rule_" + (++state.ruleCounter),
      type, config, enabled: true,
      order: state.rules.length
    };
    state.rules.push(rule);
    UI.renderRules(state.rules);
    return rule;
  }

  function updateRule(id, updates) {
    const r = state.rules.find(r => r.id === id);
    if (r) Object.assign(r, updates);
    UI.renderRules(state.rules);
  }

  function removeRule(id) {
    state.rules = state.rules.filter(r => r.id !== id);
    UI.renderRules(state.rules);
  }

  function moveRule(id, dir) {
    const idx = state.rules.findIndex(r => r.id === id);
    const target = idx + dir;
    if (target < 0 || target >= state.rules.length) return;
    [state.rules[idx], state.rules[target]] = [state.rules[target], state.rules[idx]];
    state.rules.forEach((r, i) => r.order = i);
    UI.renderRules(state.rules);
  }

  /* ---- Execute rules ---- */
  async function executeRules() {
    const ds = getActiveDS();
    if (!ds) return;
    if (state.rules.filter(r => r.enabled).length === 0) { UI.showError("没有启用的规则"); return; }

    // Push undo snapshot
    pushUndo();

    UI.showProgress("正在执行清洗规则...");
    const result = await callWorker("executeRules", {
      headers: ds.headers, data: ds.data, rules: state.rules
    });

    state.cleanedResult = result;
    ds.headers = result.headers;
    ds.data = result.data;

    // Re-detect types and issues after cleaning
    ds.columnTypes = await callWorker("inferTypes", { headers: ds.headers, data: ds.data });
    ds.issues = await callWorker("detectIssues", { headers: ds.headers, data: ds.data, columnTypes: ds.columnTypes });

    UI.renderExecutionResult(result, ds.originalData, ds.data);
    UI.renderDataPreview(ds.headers, ds.data, ds.columnTypes, ds.issues);
    UI.renderIssuesSummary(ds.issues, ds.data.length);
    await refreshQuality();
    UI.hideProgress();
  }

  /* ---- Cross-table validation ---- */
  async function crossValidate(sourceFile, sourceCol, targetFile, targetCol) {
    const src = state.datasets[sourceFile];
    const tgt = state.datasets[targetFile];
    if (!src || !tgt) { UI.showError("文件不存在"); return; }
    const result = await callWorker("crossValidate", {
      sourceHeaders: src.headers, sourceData: src.data, sourceCol,
      targetHeaders: tgt.headers, targetData: tgt.data, targetCol
    });
    UI.renderCrossValidation(result, sourceFile, sourceCol, targetFile, targetCol);
  }

  /* ---- Undo / Redo ---- */
  function pushUndo() {
    const ds = getActiveDS();
    if (!ds) return;
    state.undoStack.push({
      headers: [...ds.headers],
      data: ds.data.map(r => [...r]),
    });
    state.redoStack = [];
    if (state.undoStack.length > 30) state.undoStack.shift();
    UI.updateUndoRedo(state.undoStack.length, state.redoStack.length);
  }

  async function undo() {
    const ds = getActiveDS();
    if (!ds || state.undoStack.length === 0) return;
    state.redoStack.push({ headers: [...ds.headers], data: ds.data.map(r => [...r]) });
    const snap = state.undoStack.pop();
    ds.headers = snap.headers;
    ds.data = snap.data;
    ds.columnTypes = await callWorker("inferTypes", { headers: ds.headers, data: ds.data });
    ds.issues = await callWorker("detectIssues", { headers: ds.headers, data: ds.data, columnTypes: ds.columnTypes });
    UI.renderDataPreview(ds.headers, ds.data, ds.columnTypes, ds.issues);
    UI.renderIssuesSummary(ds.issues, ds.data.length);
    await refreshQuality();
    UI.updateUndoRedo(state.undoStack.length, state.redoStack.length);
  }

  async function redo() {
    const ds = getActiveDS();
    if (!ds || state.redoStack.length === 0) return;
    state.undoStack.push({ headers: [...ds.headers], data: ds.data.map(r => [...r]) });
    const snap = state.redoStack.pop();
    ds.headers = snap.headers;
    ds.data = snap.data;
    ds.columnTypes = await callWorker("inferTypes", { headers: ds.headers, data: ds.data });
    ds.issues = await callWorker("detectIssues", { headers: ds.headers, data: ds.data, columnTypes: ds.columnTypes });
    UI.renderDataPreview(ds.headers, ds.data, ds.columnTypes, ds.issues);
    UI.renderIssuesSummary(ds.issues, ds.data.length);
    await refreshQuality();
    UI.updateUndoRedo(state.undoStack.length, state.redoStack.length);
  }

  /* ---- Export ---- */
  async function exportCSV() {
    const ds = getActiveDS();
    if (!ds) return;
    const csv = await callWorker("exportCSV", { headers: ds.headers, data: ds.data });
    downloadBlob(csv, "cleaned_" + state.activeFile, "text/csv;charset=utf-8");
  }

  function exportErrorReport() {
    if (!state.cleanedResult) { UI.showError("请先执行规则"); return; }
    const report = {
      timestamp: new Date().toISOString(),
      file: state.activeFile,
      rules: state.rules,
      log: state.cleanedResult.log,
      errorRows: state.cleanedResult.errorRows,
      totalAffected: state.cleanedResult.totalAffected
    };
    downloadBlob(JSON.stringify(report, null, 2), "error_report.json", "application/json");
  }

  function exportRulesJSON() {
    downloadBlob(JSON.stringify(state.rules, null, 2), "rules.json", "application/json");
  }

  function importRulesJSON(json) {
    try {
      const rules = JSON.parse(json);
      if (!Array.isArray(rules)) throw new Error("Invalid format");
      state.rules = rules;
      state.ruleCounter = rules.reduce((m, r) => Math.max(m, parseInt(r.id.split("_")[1]) || 0), state.ruleCounter);
      UI.renderRules(state.rules);
    } catch (e) { UI.showError("规则JSON格式错误: " + e.message); }
  }

  async function saveRuleSetToDB(name) {
    await DB.saveRuleSet({ id: "rs_" + Date.now(), name, rules: state.rules, createdAt: Date.now() });
    UI.showSuccess("规则集已保存");
    await renderSavedRuleSets();
  }

  async function loadRuleSetFromDB(id) {
    const rs = await DB.getRuleSet(id);
    if (rs) {
      state.rules = rs.rules;
      state.ruleCounter = rs.rules.reduce((m, r) => Math.max(m, parseInt(r.id.split("_")[1]) || 0), state.ruleCounter);
      UI.renderRules(state.rules);
      UI.showSuccess("已加载规则集: " + rs.name);
    }
  }

  async function deleteRuleSetFromDB(id) {
    await DB.deleteRuleSet(id);
    await renderSavedRuleSets();
  }

  async function renderSavedRuleSets() {
    const sets = await DB.listRuleSets();
    UI.renderSavedRuleSets(sets);
  }

  /* ---- Helpers ---- */
  function getActiveDS() { return state.datasets[state.activeFile] || null; }

  function switchFile(name) {
    if (!state.datasets[name]) return;
    state.activeFile = name;
    const ds = state.datasets[name];
    UI.renderFileList(Object.keys(state.datasets), name);
    UI.renderDataPreview(ds.headers, ds.data, ds.columnTypes, ds.issues);
    UI.renderColumnInfo(ds.headers, ds.columnTypes);
    UI.renderIssuesSummary(ds.issues, ds.data.length);
    refreshQuality();
    UI.updateUndoRedo(state.undoStack.length, state.redoStack.length);
  }

  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  function detectDelimiter(text) {
    const first = text.slice(0, 2000);
    const commas = (first.match(/,/g) || []).length;
    const tabs = (first.match(/\t/g) || []).length;
    const semis = (first.match(/;/g) || []).length;
    if (tabs > commas && tabs > semis) return "\t";
    if (semis > commas) return ";";
    return ",";
  }

  function downloadBlob(content, filename, mime) {
    const bom = mime.includes("csv") ? "\uFEFF" : "";
    const blob = new Blob([bom + content], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function getState() { return state; }
  function getFiles() { return Object.keys(state.datasets); }
  function getHeaders(file) { return state.datasets[file]?.headers || []; }

  /* ---- Init ---- */
  function init() {
    initWorker();
    DB.open().then(() => renderSavedRuleSets());
  }

  return {
    init, loadFile, switchFile, addRule, updateRule, removeRule, moveRule,
    executeRules, crossValidate, undo, redo,
    exportCSV, exportErrorReport, exportRulesJSON, importRulesJSON,
    saveRuleSetToDB, loadRuleSetFromDB, deleteRuleSetFromDB,
    getState, getFiles, getHeaders, getActiveDS, renderSavedRuleSets
  };
})();
