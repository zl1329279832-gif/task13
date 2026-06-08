/* results.js — Display cleaning results with before/after comparison */

class ResultsView {
  constructor(app) {
    this.app = app;
    this.container = document.getElementById('resultsContent');
    this.lastResult = null;
  }

  show(result, profileBefore) {
    this.lastResult = { result, profileBefore };
    this.container.innerHTML = '';

    const totalRows = result.rows.length;
    const totalAffected = result.totalAffected;
    const errorCount = result.errorRows.length;
    const qBefore = profileBefore.quality;
    const qAfter = result.profileAfter.quality;

    // Summary
    const summary = document.createElement('div');
    summary.className = 'result-summary';
    summary.innerHTML = `
      <div class="result-stat"><div class="rs-value">${fmtNum(totalRows)}</div><div class="rs-label">清洗后行数</div></div>
      <div class="result-stat ${totalAffected > 0 ? 'warn' : ''}"><div class="rs-value">${fmtNum(totalAffected)}</div><div class="rs-label">影响行数(累计)</div></div>
      <div class="result-stat ${errorCount > 0 ? 'bad' : 'good'}"><div class="rs-value">${fmtNum(errorCount)}</div><div class="rs-label">错误行</div></div>
      <div class="result-stat ${qAfter >= qBefore ? 'good' : 'bad'}"><div class="rs-value">${qBefore} -> ${qAfter}</div><div class="rs-label">质量评分变化</div></div>`;
    this.container.appendChild(summary);

    // Comparison table
    const comp = document.createElement('div');
    comp.className = 'result-comparison';
    comp.innerHTML = `<h4>清洗前后对比</h4>
      <table class="comparison-table">
        <thead><tr><th>指标</th><th>清洗前</th><th>清洗后</th><th>变化</th></tr></thead>
        <tbody>
          ${this._compRow('行数', profileBefore.rowCount, result.profileAfter.rowCount, true)}
          ${this._compRow('完整性', profileBefore.qualityBreakdown.completeness, result.profileAfter.qualityBreakdown.completeness, true, true)}
          ${this._compRow('唯一性', profileBefore.qualityBreakdown.uniqueness, result.profileAfter.qualityBreakdown.uniqueness, true, true)}
          ${this._compRow('有效性', profileBefore.qualityBreakdown.validity, result.profileAfter.qualityBreakdown.validity, true, true)}
          ${this._compRow('重复行', profileBefore.duplicateCount, result.profileAfter.duplicateCount, false)}
        </tbody>
      </table>`;
    this.container.appendChild(comp);

    // Execution logs
    const logsDiv = document.createElement('div');
    logsDiv.className = 'result-logs';
    logsDiv.innerHTML = '<h4 style="margin:14px 0 8px;font-size:14px">执行日志（按顺序）</h4>';

    for (const log of result.logs) {
      const logEl = document.createElement('div');
      const hasErrors = log.errorRows && log.errorRows.length > 0;
      logEl.className = 'result-log' + (hasErrors ? ' has-errors' : '') + (log.status === 'error' ? ' log-error' : '');

      let h = `<div class="rl-header">
        <span class="rl-name">[${ruleIcon(log.ruleType)}] ${escHtml(log.ruleName)}</span>
        <span class="rl-affected">影响 ${fmtNum(log.affectedCount)} 行</span>
        <span class="rl-status ${log.status}">${log.status === 'ok' ? '成功' : '失败'}</span>
      </div>`;

      if (log.error) h += `<div class="text-danger" style="font-size:11px;margin-top:3px">${escHtml(log.error)}</div>`;

      if (log.changes && log.changes.length > 0) {
        h += '<div class="result-changes">';
        for (const c of log.changes.slice(0, 50)) {
          if (c.before !== undefined && c.after !== undefined) {
            h += `<div class="result-change"><span class="rc-row">行${c.row+1}</span><span class="rc-before">${escHtml(String(c.before))}</span><span class="rc-arrow">-></span><span class="rc-after">${escHtml(String(c.after))}</span></div>`;
          } else if (c.type === 'remove') {
            h += `<div class="result-change"><span class="rc-row">行${c.row+1}</span><span class="rc-before">删除 - ${escHtml(c.detail||'')}</span></div>`;
          } else if (c.detail) {
            h += `<div class="result-change"><span class="rc-row">行${c.row+1}</span><span class="rc-before">${escHtml(c.detail)}</span></div>`;
          }
        }
        if (log.changes.length > 50) h += `<div class="text-muted" style="font-size:10px;padding:3px 0">... 还有 ${log.changes.length - 50} 条变更记录</div>`;
        h += '</div>';
      }

      if (hasErrors) {
        h += `<div style="margin-top:3px;font-size:11px"><span class="text-danger">错误行: </span>${log.errorRows.slice(0,20).map(r => `<a href="#" class="error-row-link" data-row="${r}" style="color:var(--primary);margin-right:3px">${r+1}</a>`).join(', ')}${log.errorRows.length > 20 ? ' ...' : ''}</div>`;
      }

      logEl.innerHTML = h;
      logsDiv.appendChild(logEl);
    }
    this.container.appendChild(logsDiv);

    // Error row click
    this.container.onclick = (e) => {
      const link = e.target.closest('.error-row-link');
      if (link) {
        e.preventDefault();
        const row = parseInt(link.dataset.row);
        this.app.switchTab('data');
        this.app.grid.scrollToRow(row);
        this.app.grid.setErrorRows([row]);
      }
    };
  }

  _compRow(label, before, after, higherIsBetter, isPercent) {
    const diff = after - before;
    const suffix = isPercent ? '%' : '';
    const beforeStr = isPercent ? before + '%' : before;
    const afterStr = isPercent ? after + '%' : after;
    let cls = '', text = '';
    if (diff > 0) { cls = higherIsBetter ? 'improved' : 'degraded'; text = '+' + diff + suffix; }
    else if (diff < 0) { cls = higherIsBetter ? 'degraded' : 'improved'; text = diff + suffix; }
    else { text = '--'; }
    return `<tr><td>${label}</td><td>${beforeStr}</td><td>${afterStr}</td><td class="${cls}">${text}</td></tr>`;
  }

  generateReport() {
    if (!this.lastResult) return '';
    const { result, profileBefore } = this.lastResult;
    let r = 'CSV 数据清洗 -- 错误报告\n========================\n\n';
    r += `数据集: ${this.app.activeDatasetName}\n`;
    r += `清洗前: ${profileBefore.rowCount} 行 x ${profileBefore.columnCount} 列\n`;
    r += `清洗后: ${result.rows.length} 行 x ${result.headers.length} 列\n`;
    r += `质量评分: ${profileBefore.quality} -> ${result.profileAfter.quality}\n\n执行日志:\n`;
    for (const log of result.logs) {
      r += `\n--- ${log.ruleName} (${log.ruleType}) ---\n`;
      r += `状态: ${log.status}\n影响行数: ${log.affectedCount}\n`;
      if (log.error) r += `错误: ${log.error}\n`;
      if (log.errorRows && log.errorRows.length > 0) r += `错误行号: ${log.errorRows.map(r => r+1).join(', ')}\n`;
      if (log.changes && log.changes.length > 0) {
        r += `变更记录 (前 ${Math.min(log.changes.length, 20)} 条):\n`;
        for (const c of log.changes.slice(0, 20)) {
          if (c.before !== undefined) r += `  行 ${c.row+1}: "${c.before}" -> "${c.after}"\n`;
          else if (c.type === 'remove') r += `  行 ${c.row+1}: 删除\n`;
        }
      }
    }
    if (result.errorRows.length > 0) r += `\n\n所有错误行号:\n${result.errorRows.map(r => r+1).join(', ')}`;
    return r;
  }
}
