/* grid.js — Virtual-scrolling data grid */

class DataGrid {
  constructor(container) {
    this.container = container;
    this.headerEl = document.getElementById('gridHeader');
    this.bodyEl = document.getElementById('gridBody');

    this.headers = [];
    this.rows = [];
    this.profile = null;
    this.errorRowSet = new Set();
    this.dupRowSet = new Set();

    this.showDirty = false;
    this.showNulls = false;
    this.showDupRows = false;

    this.colWidths = [];
    this.rowHeight = 28;
    this.renderScheduled = false;

    this._onScroll = this._onScroll.bind(this);
    this.bodyEl.addEventListener('scroll', this._onScroll);

    document.getElementById('showDirty').addEventListener('change', (e) => { this.showDirty = e.target.checked; this.render(); });
    document.getElementById('showNulls').addEventListener('change', (e) => { this.showNulls = e.target.checked; this.render(); });
    document.getElementById('showDupRows').addEventListener('change', (e) => { this.showDupRows = e.target.checked; this.render(); });
  }

  setData(headers, rows, profile) {
    this.headers = headers;
    this.rows = rows;
    this.profile = profile;
    this.errorRowSet = new Set();
    this.dupRowSet = new Set();

    if (profile && profile.duplicateIndices) {
      for (const i of profile.duplicateIndices) this.dupRowSet.add(i);
    }

    this.colWidths = headers.map((h, i) => {
      let maxLen = h.length;
      for (let r = 0; r < Math.min(rows.length, 100); r++) {
        const v = (rows[r][i] || '').length;
        if (v > maxLen) maxLen = v;
      }
      return Math.max(Math.min(maxLen * 7 + 20, 300), 70);
    });

    this._updateInfo();
    this.renderHeader();
    this.bodyEl.scrollTop = 0;
    this.render();
  }

  setErrorRows(indices) {
    this.errorRowSet = new Set(indices);
    this.render();
  }

  _updateInfo() {
    const info = document.getElementById('dataInfo');
    const dupCount = this.profile ? this.profile.duplicateCount : 0;
    info.textContent = `${fmtNum(this.rows.length)} 行 x ${this.headers.length} 列` + (dupCount > 0 ? ` | ${fmtNum(dupCount)} 重复行` : '');
  }

  renderHeader() {
    const totalWidth = this.colWidths.reduce((a, b) => a + b, 0) + 50;
    let html = `<div class="gh-cell" style="width:50px;min-width:50px;text-align:center">#</div>`;
    for (let i = 0; i < this.headers.length; i++) {
      html += `<div class="gh-cell" style="width:${this.colWidths[i]}px;min-width:${this.colWidths[i]}px" title="${escHtml(this.headers[i])}">${escHtml(this.headers[i])}</div>`;
    }
    this.headerEl.innerHTML = html;
    this.headerEl.style.minWidth = totalWidth + 'px';
  }

  render() {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => { this.renderScheduled = false; this._doRender(); });
  }

  _doRender() {
    const totalRows = this.rows.length;
    const scrollTop = this.bodyEl.scrollTop;
    const viewHeight = this.bodyEl.clientHeight;
    const rh = this.rowHeight;

    const startIdx = Math.max(0, Math.floor(scrollTop / rh) - 10);
    const endIdx = Math.min(totalRows, Math.ceil((scrollTop + viewHeight) / rh) + 10);

    let html = `<div style="height:${startIdx * rh}px"></div>`;

    for (let r = startIdx; r < endIdx; r++) {
      const row = this.rows[r];
      let rowClass = 'grid-row';
      if (this.showDupRows && this.dupRowSet.has(r)) rowClass += ' dup-row';
      if (this.errorRowSet.has(r)) rowClass += ' error-row';

      html += `<div class="${rowClass}" style="height:${rh}px">`;
      html += `<div class="grid-cell" style="width:50px;min-width:50px;text-align:center;color:var(--text-muted);font-size:10px">${r + 1}</div>`;

      for (let c = 0; c < this.headers.length; c++) {
        const v = row[c] || '';
        const isEmpty = v === '' || v.toLowerCase() === 'null' || v.toLowerCase() === 'na';
        let cellClass = 'grid-cell';
        if (this.showNulls && isEmpty) cellClass += ' cell-null';
        if (this.showDirty && this.profile && this.profile.profiles[c]) {
          const prof = this.profile.profiles[c];
          if (prof.dirtySamples && prof.dirtySamples.some(d => d.row === r)) cellClass += ' cell-dirty';
        }
        if (this.errorRowSet.has(r)) cellClass += ' cell-highlight';

        const display = isEmpty && this.showNulls ? 'NULL' : v;
        html += `<div class="${cellClass}" style="width:${this.colWidths[c]}px;min-width:${this.colWidths[c]}px" title="${escHtml(v)}">${escHtml(display)}</div>`;
      }
      html += '</div>';
    }

    const remaining = Math.max(0, (totalRows - endIdx) * rh);
    html += `<div style="height:${remaining}px"></div>`;
    this.bodyEl.innerHTML = html;
  }

  _onScroll() {
    this.headerEl.style.transform = `translateX(-${this.bodyEl.scrollLeft}px)`;
    this.render();
  }

  scrollToRow(rowIdx) {
    this.bodyEl.scrollTop = rowIdx * this.rowHeight;
  }
}
