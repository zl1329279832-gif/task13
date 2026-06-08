/* ============================================================
   ui.js  –  All DOM rendering and event binding
   ============================================================ */

const UI = (() => {

  /* ---- DOM refs (populated on init) ---- */
  let els = {};

  function $(id) { return document.getElementById(id); }

  function init() {
    els = {
      dropZone: $("dropZone"), fileInput: $("fileInput"), fileList: $("fileList"),
      progressBar: $("progressBar"), progressText: $("progressText"),
      dataTable: $("dataTable"), tableHead: $("tableHead"), tableBody: $("tableBody"),
      rowCount: $("rowCount"), colCount: $("colCount"),
      columnInfo: $("columnInfo"), issuesSummary: $("issuesSummary"),
      ruleList: $("ruleList"), addRuleType: $("addRuleType"), addRuleBtn: $("addRuleBtn"),
      executeBtn: $("executeBtn"), ruleConfigPanel: $("ruleConfigPanel"),
      diffPanel: $("diffPanel"), diffContent: $("diffContent"),
      qualityCanvas: $("qualityCanvas"), qualityDetails: $("qualityDetails"),
      undoBtn: $("undoBtn"), redoBtn: $("redoBtn"),
      exportCSVBtn: $("exportCSVBtn"), exportErrorBtn: $("exportErrorBtn"),
      exportRulesBtn: $("exportRulesBtn"), importRulesBtn: $("importRulesBtn"),
      importRulesFile: $("importRulesFile"),
      savedRuleSets: $("savedRuleSets"), saveRuleSetBtn: $("saveRuleSetBtn"),
      ruleSetName: $("ruleSetName"),
      crossSource: $("crossSource"), crossSourceCol: $("crossSourceCol"),
      crossTarget: $("crossTarget"), crossTargetCol: $("crossTargetCol"),
      crossValidateBtn: $("crossValidateBtn"), crossResult: $("crossResult"),
      notification: $("notification"),
      pageInfo: $("pageInfo"), prevPage: $("prevPage"), nextPage: $("nextPage"),
    };
    bindEvents();
  }

  /* ============================================================
     Event Binding
     ============================================================ */
  let currentPage = 0;
  const PAGE_SIZE = 200;

  function bindEvents() {
    // Drag & Drop
    els.dropZone.addEventListener("dragover", (e) => { e.preventDefault(); els.dropZone.classList.add("drag-over"); });
    els.dropZone.addEventListener("dragleave", () => els.dropZone.classList.remove("drag-over"));
    els.dropZone.addEventListener("drop", handleDrop);
    els.dropZone.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", (e) => { handleFiles(e.target.files); });

    // Buttons
    els.addRuleBtn.addEventListener("click", openRuleConfig);
    els.executeBtn.addEventListener("click", () => App.executeRules());
    els.undoBtn.addEventListener("click", () => App.undo());
    els.redoBtn.addEventListener("click", () => App.redo());
    els.exportCSVBtn.addEventListener("click", () => App.exportCSV());
    els.exportErrorBtn.addEventListener("click", () => App.exportErrorReport());
    els.exportRulesBtn.addEventListener("click", () => App.exportRulesJSON());
    els.importRulesBtn.addEventListener("click", () => els.importRulesFile.click());
    els.importRulesFile.addEventListener("change", handleImportRules);
    els.saveRuleSetBtn.addEventListener("click", handleSaveRuleSet);
    els.crossValidateBtn.addEventListener("click", handleCrossValidate);
    els.prevPage.addEventListener("click", () => { if (currentPage > 0) { currentPage--; renderCurrentPage(); } });
    els.nextPage.addEventListener("click", () => { currentPage++; renderCurrentPage(); });

    // cross-table file selectors
    els.crossSource.addEventListener("change", () => {
      populateColSelect(els.crossSourceCol, els.crossSource.value);
    });
    els.crossTarget.addEventListener("change", () => {
      populateColSelect(els.crossTargetCol, els.crossTarget.value);
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); App.undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); App.redo(); }
    });
  }

  function handleDrop(e) {
    e.preventDefault();
    els.dropZone.classList.remove("drag-over");
    handleFiles(e.dataTransfer.files);
  }

  function handleFiles(files) {
    for (const f of files) {
      if (f.name.endsWith(".csv") || f.name.endsWith(".tsv") || f.name.endsWith(".txt")) {
        App.loadFile(f);
      } else {
        showError("不支持的文件格式: " + f.name);
      }
    }
  }

  function handleImportRules(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => App.importRulesJSON(reader.result);
    reader.readAsText(file);
    e.target.value = "";
  }

  async function handleSaveRuleSet() {
    const name = els.ruleSetName.value.trim();
    if (!name) { showError("请输入规则集名称"); return; }
    await App.saveRuleSetToDB(name);
    els.ruleSetName.value = "";
  }

  function handleCrossValidate() {
    const sf = els.crossSource.value, sc = els.crossSourceCol.value;
    const tf = els.crossTarget.value, tc = els.crossTargetCol.value;
    if (!sf || !sc || !tf || !tc) { showError("请选择文件和字段"); return; }
    App.crossValidate(sf, sc, tf, tc);
  }

  function populateColSelect(select, fileName) {
    select.innerHTML = '<option value="">选择字段</option>';
    if (!fileName) return;
    const headers = App.getHeaders(fileName);
    headers.forEach(h => {
      const o = document.createElement("option");
      o.value = h; o.textContent = h;
      select.appendChild(o);
    });
  }

  /* ============================================================
     Rendering
     ============================================================ */

  /* ---- File list ---- */
  function renderFileList(files, active) {
    els.fileList.innerHTML = "";
    files.forEach(f => {
      const btn = document.createElement("button");
      btn.className = "file-tab" + (f === active ? " active" : "");
      btn.textContent = f;
      btn.onclick = () => App.switchFile(f);
      els.fileList.appendChild(btn);
    });
    // Update cross-validate file selectors
    [els.crossSource, els.crossTarget].forEach(sel => {
      const cur = sel.value;
      sel.innerHTML = '<option value="">选择文件</option>';
      files.forEach(f => {
        const o = document.createElement("option");
        o.value = f; o.textContent = f;
        sel.appendChild(o);
      });
      sel.value = cur;
    });
  }

  /* ---- Data preview table with pagination ---- */
  let _previewHeaders = [], _previewData = [], _previewTypes = {}, _previewIssues = {};

  function renderDataPreview(headers, data, types, issues) {
    _previewHeaders = headers;
    _previewData = data;
    _previewTypes = types || {};
    _previewIssues = issues || {};
    currentPage = 0;
    renderCurrentPage();
  }

  function renderCurrentPage() {
    const headers = _previewHeaders;
    const data = _previewData;
    const start = currentPage * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, data.length);
    const totalPages = Math.ceil(data.length / PAGE_SIZE) || 1;

    // Header
    els.tableHead.innerHTML = "<tr><th>#</th>" + headers.map((h, i) => {
      const t = _previewTypes[h];
      const badge = t ? `<span class="type-badge type-${t.type}">${t.type}</span>` : "";
      const pk = (t && t.isPrimaryKey) ? ' <span class="pk-badge">PK</span>' : "";
      return `<th>${esc(h)}${badge}${pk}</th>`;
    }).join("") + "</tr>";

    // Build issue lookup for this page
    const issueMap = {};
    if (_previewIssues.nullCells) {
      _previewIssues.nullCells.forEach(c => {
        if (c.row >= start && c.row < end) {
          issueMap[c.row + "," + c.col] = "null-cell";
        }
      });
    }
    if (_previewIssues.dirtyData) {
      _previewIssues.dirtyData.forEach(c => {
        if (c.row >= start && c.row < end) {
          issueMap[c.row + "," + c.col] = "dirty-cell";
        }
      });
    }
    const dupSet = new Set();
    if (_previewIssues.duplicateRows) {
      _previewIssues.duplicateRows.forEach(d => dupSet.add(d.row));
    }

    // Body
    const frag = document.createDocumentFragment();
    for (let r = start; r < end; r++) {
      const tr = document.createElement("tr");
      if (dupSet.has(r)) tr.classList.add("dup-row");
      const tdIdx = document.createElement("td");
      tdIdx.className = "row-num";
      tdIdx.textContent = r + 1;
      tr.appendChild(tdIdx);
      for (let c = 0; c < headers.length; c++) {
        const td = document.createElement("td");
        const val = data[r][c] !== undefined ? data[r][c] : "";
        td.textContent = val;
        const cls = issueMap[r + "," + c];
        if (cls) td.classList.add(cls);
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    els.tableBody.innerHTML = "";
    els.tableBody.appendChild(frag);

    els.rowCount.textContent = data.length.toLocaleString();
    els.colCount.textContent = headers.length;
    els.pageInfo.textContent = `${currentPage + 1} / ${totalPages}`;
    els.prevPage.disabled = currentPage === 0;
    els.nextPage.disabled = end >= data.length;
  }

  /* ---- Column info ---- */
  function renderColumnInfo(headers, types) {
    let html = '<table class="info-table"><tr><th>字段</th><th>类型</th><th>空值率</th><th>唯一值</th><th>主键</th></tr>';
    headers.forEach(h => {
      const t = types[h] || {};
      html += `<tr>
        <td>${esc(h)}</td>
        <td><span class="type-badge type-${t.type || "string"}">${t.type || "?"}</span></td>
        <td>${((t.nullRate || 0) * 100).toFixed(1)}%</td>
        <td>${t.uniqueCount || "-"}</td>
        <td>${t.isPrimaryKey ? "Yes" : "-"}</td>
      </tr>`;
      if (t.type === "enum" && t.enumValues) {
        html += `<tr><td colspan="5" class="enum-vals">枚举值: ${t.enumValues.map(esc).join(", ")}</td></tr>`;
      }
    });
    html += "</table>";
    els.columnInfo.innerHTML = html;
  }

  /* ---- Issues summary ---- */
  function renderIssuesSummary(issues, rowCount) {
    const nc = issues.nullCells?.length || 0;
    const dr = issues.duplicateRows?.length || 0;
    const dd = issues.dirtyData?.length || 0;
    els.issuesSummary.innerHTML = `
      <div class="issue-cards">
        <div class="issue-card ${nc ? 'warn' : 'ok'}">
          <div class="issue-num">${nc.toLocaleString()}</div>
          <div class="issue-label">空值单元格</div>
        </div>
        <div class="issue-card ${dr ? 'warn' : 'ok'}">
          <div class="issue-num">${dr.toLocaleString()}</div>
          <div class="issue-label">重复行</div>
        </div>
        <div class="issue-card ${dd ? 'warn' : 'ok'}">
          <div class="issue-num">${dd.toLocaleString()}</div>
          <div class="issue-label">脏数据</div>
        </div>
        <div class="issue-card">
          <div class="issue-num">${rowCount.toLocaleString()}</div>
          <div class="issue-label">总行数</div>
        </div>
      </div>`;
  }

  /* ---- Rules list ---- */
  const RULE_LABELS = {
    dedup: "去重", fillNull: "空值填充", splitField: "字段拆分",
    dateStandardize: "日期标准化", amountConvert: "金额转换",
    enumMap: "枚举映射", rename: "字段重命名", crossValidate: "跨表校验"
  };

  function renderRules(rules) {
    if (rules.length === 0) {
      els.ruleList.innerHTML = '<div class="empty-hint">暂无规则，点击"添加规则"开始配置</div>';
      return;
    }
    els.ruleList.innerHTML = "";
    rules.forEach((r, i) => {
      const div = document.createElement("div");
      div.className = "rule-item" + (r.enabled ? "" : " disabled");
      div.draggable = true;
      div.dataset.id = r.id;
      div.innerHTML = `
        <span class="rule-order">#${i + 1}</span>
        <span class="rule-type-label">${RULE_LABELS[r.type] || r.type}</span>
        <span class="rule-summary">${ruleSummary(r)}</span>
        <div class="rule-actions">
          <button class="btn-icon" data-act="up" title="上移">&#9650;</button>
          <button class="btn-icon" data-act="down" title="下移">&#9660;</button>
          <button class="btn-icon" data-act="toggle" title="启用/禁用">${r.enabled ? "&#10003;" : "&#10007;"}</button>
          <button class="btn-icon btn-danger" data-act="delete" title="删除">&#10005;</button>
        </div>`;
      div.querySelector('[data-act="up"]').onclick = () => App.moveRule(r.id, -1);
      div.querySelector('[data-act="down"]').onclick = () => App.moveRule(r.id, 1);
      div.querySelector('[data-act="toggle"]').onclick = () => App.updateRule(r.id, { enabled: !r.enabled });
      div.querySelector('[data-act="delete"]').onclick = () => App.removeRule(r.id);
      els.ruleList.appendChild(div);
    });
  }

  function ruleSummary(r) {
    const c = r.config;
    switch (r.type) {
      case "dedup": return c.columns?.length ? `按 ${c.columns.join(",")} 去重` : "全字段去重";
      case "fillNull": return `${c.column} - ${c.strategy || "固定值"}`;
      case "splitField": return `${c.column} 按 "${c.separator}" 拆分`;
      case "dateStandardize": return `${c.column} -> ${c.format}`;
      case "amountConvert": return `${c.column} x${c.rate} ${c.targetUnit || ""}`;
      case "enumMap": return `${c.column} 映射${Object.keys(c.mapping || {}).length}项`;
      case "rename": return `${c.oldName} -> ${c.newName}`;
      default: return "";
    }
  }

  /* ---- Rule config modal ---- */
  function openRuleConfig() {
    const type = els.addRuleType.value;
    const ds = App.getActiveDS();
    if (!ds) { showError("请先导入文件"); return; }
    const headers = ds.headers;

    let html = `<div class="modal-overlay" id="ruleModal">
      <div class="modal">
        <h3>添加规则: ${RULE_LABELS[type] || type}</h3>
        <div class="modal-body">${ruleConfigForm(type, headers)}</div>
        <div class="modal-footer">
          <button class="btn" id="ruleModalCancel">取消</button>
          <button class="btn btn-primary" id="ruleModalOK">确认</button>
        </div>
      </div></div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    const modal = $("ruleModal");

    // Enum mapping: populate values
    if (type === "enumMap") {
      const sel = modal.querySelector("#rcCol");
      sel.addEventListener("change", () => {
        const col = sel.value;
        const ct = ds.columnTypes[col];
        const container = modal.querySelector("#enumMapEntries");
        if (ct && ct.enumValues) {
          container.innerHTML = ct.enumValues.map(v =>
            `<div class="enum-entry"><span>${esc(v)}</span> <span>-></span> <input type="text" data-from="${esc(v)}" value="${esc(v)}" /></div>`
          ).join("");
        }
      });
    }

    $("ruleModalCancel").onclick = () => modal.remove();
    $("ruleModalOK").onclick = () => {
      const config = collectRuleConfig(type, modal);
      if (config) { App.addRule(type, config); modal.remove(); }
    };
  }

  function ruleConfigForm(type, headers) {
    const colOpts = headers.map(h => `<option value="${esc(h)}">${esc(h)}</option>`).join("");
    switch (type) {
      case "dedup":
        return `<label>去重字段 (留空=全字段)</label>
          <select id="rcCols" multiple class="rc-select">${colOpts}</select>
          <p class="hint">按住 Ctrl 多选</p>`;
      case "fillNull":
        return `<label>目标字段</label><select id="rcCol" class="rc-select">${colOpts}</select>
          <label>策略</label><select id="rcStrategy" class="rc-select">
            <option value="value">固定值</option><option value="mean">均值</option>
            <option value="median">中位数</option><option value="mode">众数</option>
            <option value="forward">向前填充</option></select>
          <label>固定值 (策略为固定值时)</label><input type="text" id="rcValue" class="rc-input"/>`;
      case "splitField":
        return `<label>目标字段</label><select id="rcCol" class="rc-select">${colOpts}</select>
          <label>分隔符</label><input type="text" id="rcSep" class="rc-input" value=","/>
          <label>新字段名 (逗号分隔)</label><input type="text" id="rcNewCols" class="rc-input" placeholder="字段1,字段2"/>`;
      case "dateStandardize":
        return `<label>目标字段</label><select id="rcCol" class="rc-select">${colOpts}</select>
          <label>目标格式</label><select id="rcFormat" class="rc-select">
            <option value="YYYY-MM-DD">YYYY-MM-DD</option>
            <option value="YYYY/MM/DD">YYYY/MM/DD</option>
            <option value="DD/MM/YYYY">DD/MM/YYYY</option>
            <option value="MM/DD/YYYY">MM/DD/YYYY</option>
            <option value="YYYYMMDD">YYYYMMDD</option></select>`;
      case "amountConvert":
        return `<label>目标字段</label><select id="rcCol" class="rc-select">${colOpts}</select>
          <label>汇率/倍率</label><input type="number" id="rcRate" class="rc-input" value="1" step="0.0001"/>
          <label>目标单位</label><input type="text" id="rcUnit" class="rc-input" placeholder="CNY"/>`;
      case "enumMap":
        return `<label>目标字段</label><select id="rcCol" class="rc-select">${colOpts}</select>
          <div id="enumMapEntries" class="enum-map-area"><p class="hint">选择字段后自动加载枚举值</p></div>`;
      case "rename":
        return `<label>原字段名</label><select id="rcOldName" class="rc-select">${colOpts}</select>
          <label>新字段名</label><input type="text" id="rcNewName" class="rc-input"/>`;
      default:
        return "<p>未知规则类型</p>";
    }
  }

  function collectRuleConfig(type, modal) {
    const q = (s) => modal.querySelector(s);
    switch (type) {
      case "dedup": {
        const sel = q("#rcCols");
        const cols = [...sel.selectedOptions].map(o => o.value);
        return { columns: cols };
      }
      case "fillNull": {
        const col = q("#rcCol").value;
        const strategy = q("#rcStrategy").value;
        const value = q("#rcValue").value;
        if (!col) { showError("请选择字段"); return null; }
        return { column: col, strategy, value };
      }
      case "splitField": {
        const col = q("#rcCol").value;
        const sep = q("#rcSep").value || ",";
        const nc = q("#rcNewCols").value.split(",").map(s => s.trim()).filter(Boolean);
        if (!col) { showError("请选择字段"); return null; }
        return { column: col, separator: sep, newColumns: nc.length ? nc : undefined };
      }
      case "dateStandardize": {
        const col = q("#rcCol").value;
        const format = q("#rcFormat").value;
        if (!col) { showError("请选择字段"); return null; }
        return { column: col, format };
      }
      case "amountConvert": {
        const col = q("#rcCol").value;
        const rate = parseFloat(q("#rcRate").value) || 1;
        const unit = q("#rcUnit").value.trim();
        if (!col) { showError("请选择字段"); return null; }
        return { column: col, rate, targetUnit: unit };
      }
      case "enumMap": {
        const col = q("#rcCol").value;
        if (!col) { showError("请选择字段"); return null; }
        const entries = modal.querySelectorAll("#enumMapEntries .enum-entry input");
        const mapping = {};
        entries.forEach(inp => { mapping[inp.dataset.from] = inp.value; });
        return { column: col, mapping };
      }
      case "rename": {
        const oldName = q("#rcOldName").value;
        const newName = q("#rcNewName").value.trim();
        if (!oldName || !newName) { showError("请填写字段名"); return null; }
        return { oldName, newName };
      }
    }
    return null;
  }

  /* ---- Execution result / diff ---- */
  function renderExecutionResult(result, originalData, cleanedData) {
    let html = '<h4>执行结果</h4>';
    html += `<div class="exec-summary">
      <span>影响行数: <strong>${result.totalAffected.toLocaleString()}</strong></span>
      <span>原始行数: <strong>${originalData.length.toLocaleString()}</strong></span>
      <span>清洗后行数: <strong>${cleanedData.length.toLocaleString()}</strong></span>
      <span>错误: <strong>${result.errorRows.length.toLocaleString()}</strong></span>
    </div>`;

    // Rule execution log
    html += '<div class="exec-log"><h5>执行日志 (按执行顺序)</h5>';
    result.log.forEach((l, i) => {
      const hasErr = l.errors.length > 0;
      html += `<div class="log-entry ${hasErr ? "log-error" : "log-ok"}">
        <span class="log-idx">${i + 1}</span>
        <span class="log-type">${RULE_LABELS[l.type] || l.type}</span>
        <span class="log-affected">影响 ${l.affected} 行</span>
        ${hasErr ? `<span class="log-err-count">${l.errors.length} 个错误</span>` : ""}
      </div>`;
      if (hasErr) {
        html += '<div class="log-errors">';
        l.errors.slice(0, 20).forEach(e => {
          html += `<div class="log-err-item">行${(e.row !== undefined ? e.row + 1 : "?")} 列${e.col !== undefined ? e.col : "?"}: ${esc(e.msg || e.value || "")}</div>`;
        });
        if (l.errors.length > 20) html += `<div class="log-err-item">...还有 ${l.errors.length - 20} 个错误</div>`;
        html += "</div>";
      }
    });
    html += "</div>";

    // Error row positions
    if (result.errorRows.length > 0) {
      html += '<div class="error-rows"><h5>错误行定位</h5><table class="info-table"><tr><th>行</th><th>列</th><th>值</th><th>规则</th></tr>';
      result.errorRows.slice(0, 50).forEach(e => {
        html += `<tr><td>${e.row + 1}</td><td>${e.col}</td><td>${esc(e.value)}</td><td>${e.rule}</td></tr>`;
      });
      html += "</table></div>";
    }

    els.diffPanel.style.display = "block";
    els.diffContent.innerHTML = html;
  }

  /* ---- Quality score with Canvas ---- */
  function renderQualityScore(score) {
    const canvas = els.qualityCanvas;
    const ctx = canvas.getContext("2d");
    const W = canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
    const H = canvas.height = 200 * (window.devicePixelRatio || 1);
    canvas.style.height = "200px";
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    const w = canvas.offsetWidth, h = 200;
    ctx.clearRect(0, 0, w, h);

    const metrics = [
      { label: "完整性", value: score.completeness, color: "#4CAF50" },
      { label: "唯一性", value: score.uniqueness, color: "#2196F3" },
      { label: "有效性", value: score.validity, color: "#FF9800" },
      { label: "综合评分", value: score.overall, color: "#9C27B0" },
    ];

    const barW = 60, gap = (w - metrics.length * barW) / (metrics.length + 1);
    ctx.textAlign = "center";
    ctx.font = "12px sans-serif";

    metrics.forEach((m, i) => {
      const x = gap + i * (barW + gap);
      const barH = (m.value / 100) * (h - 50);
      const y = h - 30 - barH;

      // Bar background
      ctx.fillStyle = "#e0e0e0";
      ctx.fillRect(x, 20, barW, h - 50);

      // Bar fill
      ctx.fillStyle = m.color;
      ctx.fillRect(x, y, barW, barH);

      // Value
      ctx.fillStyle = "#333";
      ctx.fillText(m.value.toFixed(1) + "%", x + barW / 2, y - 5);

      // Label
      ctx.fillText(m.label, x + barW / 2, h - 10);
    });

    els.qualityDetails.innerHTML = `
      <div class="quality-stats">
        <span>总单元格: ${score.stats.totalCells.toLocaleString()}</span>
        <span>空值: ${score.stats.nulls.toLocaleString()}</span>
        <span>重复行: ${score.stats.dupes.toLocaleString()}</span>
        <span>脏数据: ${score.stats.dirtyCount.toLocaleString()}</span>
      </div>`;
  }

  /* ---- Saved rule sets ---- */
  function renderSavedRuleSets(sets) {
    if (!sets || sets.length === 0) {
      els.savedRuleSets.innerHTML = '<div class="empty-hint">暂无已保存的规则集</div>';
      return;
    }
    els.savedRuleSets.innerHTML = "";
    sets.forEach(s => {
      const div = document.createElement("div");
      div.className = "saved-rs";
      div.innerHTML = `<span class="rs-name">${esc(s.name)}</span>
        <span class="rs-count">${s.rules.length} 条规则</span>
        <span class="rs-time">${new Date(s.createdAt || s.updatedAt).toLocaleDateString()}</span>
        <button class="btn btn-sm" data-act="load">加载</button>
        <button class="btn btn-sm btn-danger" data-act="del">删除</button>`;
      div.querySelector('[data-act="load"]').onclick = () => App.loadRuleSetFromDB(s.id);
      div.querySelector('[data-act="del"]').onclick = () => App.deleteRuleSetFromDB(s.id);
      els.savedRuleSets.appendChild(div);
    });
  }

  /* ---- Cross-table validation result ---- */
  function renderCrossValidation(result, sf, sc, tf, tc) {
    if (result.orphanRows.length === 0) {
      els.crossResult.innerHTML = `<div class="cross-ok">全部匹配! ${esc(sf)}.${esc(sc)} 的每个值都在 ${esc(tf)}.${esc(tc)} 中存在</div>`;
    } else {
      let html = `<div class="cross-warn">发现 ${result.orphanRows.length} 个不匹配的值:</div>`;
      html += '<table class="info-table"><tr><th>行号</th><th>值</th></tr>';
      result.orphanRows.slice(0, 100).forEach(r => {
        html += `<tr><td>${r.row + 1}</td><td>${esc(r.value)}</td></tr>`;
      });
      if (result.orphanRows.length > 100) html += `<tr><td colspan="2">...还有 ${result.orphanRows.length - 100} 条</td></tr>`;
      html += "</table>";
      els.crossResult.innerHTML = html;
    }
  }

  /* ---- Undo/Redo button state ---- */
  function updateUndoRedo(undoLen, redoLen) {
    els.undoBtn.disabled = undoLen === 0;
    els.redoBtn.disabled = redoLen === 0;
    els.undoBtn.textContent = `撤销 (${undoLen})`;
    els.redoBtn.textContent = `重做 (${redoLen})`;
  }

  /* ---- Progress / Notifications ---- */
  function showProgress(msg) {
    els.progressBar.style.display = "block";
    els.progressText.textContent = msg || "处理中...";
  }
  function hideProgress() {
    els.progressBar.style.display = "none";
  }
  function showError(msg) { notify(msg, "error"); }
  function showSuccess(msg) { notify(msg, "success"); }
  function notify(msg, type) {
    els.notification.textContent = msg;
    els.notification.className = "notification show " + type;
    setTimeout(() => els.notification.className = "notification", 3000);
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  return {
    init, renderFileList, renderDataPreview, renderColumnInfo, renderIssuesSummary,
    renderRules, renderExecutionResult, renderQualityScore, renderSavedRuleSets,
    renderCrossValidation, updateUndoRedo,
    showProgress, hideProgress, showError, showSuccess
  };
})();
