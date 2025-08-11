(function () {
    // Surface any runtime errors directly in the view to aid debugging
    window.addEventListener('error', (e) => {
        const t = document.getElementById('table');
        if (t) t.textContent = 'Script error: ' + (e && e.message ? e.message : String(e));
    });
    window.addEventListener('unhandledrejection', (e) => {
        const t = document.getElementById('table');
        const msg = (e && (e.reason && e.reason.message)) ? e.reason.message : String(e.reason || e);
        if (t) t.textContent = 'Unhandled promise rejection: ' + msg;
    });

    const vscode = (typeof acquireVsCodeApi !== 'undefined') ? acquireVsCodeApi() : undefined;
    if (vscode && typeof vscode.postMessage === 'function') {
        vscode.postMessage({ type: 'ready' });
    } else {
        window.addEventListener('load', () => {
            try { if (vscode && vscode.postMessage) vscode.postMessage({ type: 'ready' }); } catch (_) { }
        });
    }

    let currentRows = [];
    let sortKey = null;
    let sortDir = 1; // 1 asc, -1 desc
    let pageIndex = 0;
    let pageSize = 100;
    let columnsCache = [];

    function computeColumns(rows) {
        const set = new Set();
        let sawObject = false;
        rows.forEach(r => {
            if (r && typeof r === 'object' && !Array.isArray(r)) {
                sawObject = true;
                Object.keys(r).forEach(k => set.add(k));
            }
        });
        if (!sawObject) return ['value'];
        return Array.from(set.values());
    }

    function escapeHtml(x) { return typeof x === 'string' ? x.replace(/&/g, '&amp;').replace(/</g, '&lt;') : x; }
    function valueToHtml(v) {
        if (v === null || v === undefined) return '<td><em class="muted">null</em></td>';
        if (typeof v === 'object') return '<td><code>' + escapeHtml(JSON.stringify(v, null, 2)) + '</code></td>';
        return '<td>' + escapeHtml(String(v)) + '</td>';
    }

    function render(rows) {
        currentRows = Array.isArray(rows) ? rows.slice() : [];
        if (!rows || rows.length === 0) { document.getElementById('table').textContent = 'No rows.'; return; }
        const cols = computeColumns(currentRows);
        columnsCache = cols;
        const header = '<tr>' + cols.map(c => '<th data-col="' + c + '"><div style="display:flex;align-items:center;gap:6px"><span class="sort-handle" data-col="' + c + '">' + c + '</span><input data-filter="' + c + '" placeholder="filter" style="flex:1;min-width:120px"/></div></th>').join('') + '</tr>';
        const rowsHtml = currentRows.map(r => {
            if (cols.length === 1 && cols[0] === 'value') return '<tr>' + valueToHtml(r) + '</tr>';
            return '<tr>' + cols.map(c => valueToHtml(r ? r[c] : undefined)).join('') + '</tr>';
        }).join('');
        const container = document.getElementById('table');
        if (!container) return;
        container.innerHTML = '<div style="margin-bottom:8px"><input id="filterBox" placeholder="Global filter (JSON includes)…" style="width: 40%"/></div><table>' + header + rowsHtml + '</table>';
        wireUp(cols);
        setupPager();
    }

    function wireUp(cols) {
        const table = document.querySelector('#table table');
        const filterBox = document.getElementById('filterBox');
        if (filterBox) {
            filterBox.addEventListener('input', () => applyFilterSort(cols));
        }
        table.querySelectorAll('.sort-handle').forEach((span) => {
            span.addEventListener('click', () => {
                const key = span.getAttribute('data-col');
                if (!key) return;
                if (sortKey === key) { sortDir = -sortDir; } else { sortKey = key; sortDir = 1; }
                applyFilterSort(cols);
            });
        });
        table.querySelectorAll('input[data-filter]').forEach(inp => {
            inp.addEventListener('input', () => applyFilterSort(cols));
        });
    }

    function applyFilterSort(cols) {
        let rows = currentRows.slice();
        const globalFilterEl = document.getElementById('filterBox');
        const globalFilter = globalFilterEl ? (globalFilterEl.value || '') : '';
        if (globalFilter) {
            rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(globalFilter.toLowerCase()));
        }
        const perColFilters = {};
        document.querySelectorAll('input[data-filter]').forEach(inp => {
            const key = inp.getAttribute('data-filter');
            const val = inp.value || '';
            if (val) perColFilters[key] = val.toLowerCase();
        });
        const filterKeys = Object.keys(perColFilters);
        if (filterKeys.length) {
            if (cols.length === 1 && cols[0] === 'value') {
                rows = rows.filter(r => String(r ?? '').toLowerCase().includes(perColFilters['value'] || ''));
            } else {
                rows = rows.filter(r => filterKeys.every(k => String((r || {})[k] ?? '').toLowerCase().includes(perColFilters[k])));
            }
        }
        if (sortKey) {
            rows.sort((a, b) => {
                const av = (cols.length === 1 && cols[0] === 'value') ? a : (a ? a[sortKey] : undefined);
                const bv = (cols.length === 1 && cols[0] === 'value') ? b : (b ? b[sortKey] : undefined);
                if (av == null && bv == null) return 0;
                if (av == null) return -1 * sortDir;
                if (bv == null) return 1 * sortDir;
                if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir;
                return String(av).localeCompare(String(bv)) * sortDir;
            });
        }
        const sortMarker = (c) => (sortKey === c ? (sortDir > 0 ? ' \u25B2' : ' \u25BC') : '');
        const header = '<tr>' + cols.map(c => '<th data-col="' + c + '"><div style="display:flex;align-items:center;gap:6px"><span class="sort-handle" data-col="' + c + '">' + c + sortMarker(c) + '</span><input data-filter="' + c + '" placeholder="filter" style="flex:1;min-width:120px"/></div></th>').join('') + '</tr>';
        const bodyRows = paginate(rows, pageIndex, pageSize);
        const bodyHtml = bodyRows.map(r => {
            if (cols.length === 1 && cols[0] === 'value') return '<tr>' + valueToHtml(r) + '</tr>';
            return '<tr>' + cols.map(c => valueToHtml(r ? r[c] : undefined)).join('') + '</tr>';
        }).join('');
        const table = document.querySelector('#table table');
        table.innerHTML = header + bodyHtml;
        updatePager(rows.length);
        table.querySelectorAll('.sort-handle').forEach((span) => {
            span.addEventListener('click', () => {
                const key = span.getAttribute('data-col');
                if (!key) return;
                if (sortKey === key) { sortDir = -sortDir; } else { sortKey = key; sortDir = 1; }
                applyFilterSort(cols);
            });
        });
        table.querySelectorAll('input[data-filter]').forEach(inp => {
            inp.addEventListener('input', () => applyFilterSort(cols));
        });
    }

    function paginate(rows, index, size) {
        const start = Math.max(0, index) * Math.max(1, size);
        return rows.slice(start, start + Math.max(1, size));
    }

    function setupPager() {
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');
        const pageSizeSel = document.getElementById('pageSize');
        const exportJson = document.getElementById('exportJson');
        const exportCsv = document.getElementById('exportCsv');
        prevBtn.addEventListener('click', () => { if (pageIndex > 0) { pageIndex--; applyFilterSort(columnsCache); } });
        nextBtn.addEventListener('click', () => { pageIndex++; applyFilterSort(columnsCache); });
        pageSizeSel.addEventListener('change', () => { pageSize = parseInt(pageSizeSel.value, 10) || 100; pageIndex = 0; applyFilterSort(columnsCache); });
        exportJson.addEventListener('click', () => {
            const blob = new Blob([JSON.stringify(currentRows, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = 'results.json'; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 500);
        });
        exportCsv.addEventListener('click', () => {
            const cols = columnsCache.length ? columnsCache : computeColumns(currentRows);
            const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
            const header = cols.join(',');
            const lines = currentRows.map(r => {
                if (cols.length === 1 && cols[0] === 'value') return esc(r);
                return cols.map(c => {
                    const v = r ? r[c] : '';
                    if (v == null) return '';
                    return (typeof v === 'object') ? esc(JSON.stringify(v)) : esc(v);
                }).join(',');
            });
            const csv = [header, ...lines].join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = 'results.csv'; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 500);
        });
    }

    function updatePager(total) {
        const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
        const info = document.getElementById('pageInfo');
        info.textContent = (Math.min(pageIndex + 1, totalPages)) + ' / ' + totalPages;
    }

    // Ready indicator
    setTimeout(() => { const t = document.getElementById('table'); if (t && t.textContent && t.textContent.includes('Waiting')) { t.textContent = 'Listening for results…'; } }, 0);

    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (msg.type === 'rows') {
            if (msg.opts && msg.opts.pageSize) {
                pageSize = parseInt(String(msg.opts.pageSize), 10) || pageSize;
            }
            render(msg.rows);
            if (msg.opts && msg.opts.truncated) {
                const tableDiv = document.getElementById('table');
                const note = document.createElement('div');
                note.className = 'muted';
                note.style.marginTop = '6px';
                note.textContent = 'Results truncated for performance.';
                tableDiv.appendChild(note);
            }
        } else if (msg.type === 'ping') {
            if (vscode && typeof vscode.postMessage === 'function') { vscode.postMessage({ type: 'ready' }); }
        }
    });
})();


