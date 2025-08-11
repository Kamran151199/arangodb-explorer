import * as vscode from "vscode";

export class ResultsPanel {
  public static currentPanel: ResultsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private isReady = false;
  private pendingMessages: any[] = [];
  private lastMessage: any | undefined;
  private retryTimer: NodeJS.Timeout | undefined;

  static show(extensionUri: vscode.Uri, title = "AQL Results"): ResultsPanel {
    if (ResultsPanel.currentPanel) {
      ResultsPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      // Re-load HTML to ensure latest script (useful after extension updates or script errors)
      (ResultsPanel.currentPanel as ResultsPanel).reload();
      // Ask the webview to confirm readiness if not yet marked
      (ResultsPanel.currentPanel as ResultsPanel).ensureReadyPing();
      return ResultsPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "arangodbResults",
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    ResultsPanel.currentPanel = new ResultsPanel(panel, extensionUri);
    return ResultsPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg && msg.type === 'ready') {
        this.isReady = true;
        // flush queued
        for (const m of this.pendingMessages) {
          try { this.panel.webview.postMessage(m); } catch { /* ignore */ }
        }
        this.pendingMessages = [];
      }
    }, undefined, this.disposables);

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private ensureReadyPing() {
    try { this.panel.webview.postMessage({ type: 'ping' }); } catch { /* ignore */ }
  }

  private reload() {
    // Reset flags and reapply HTML to recover from CSP/script issues
    this.isReady = false;
    this.pendingMessages = [];
    this.lastMessage = undefined;
    this.panel.webview.html = this.getHtml(this.panel.webview);
  }

  dispose() {
    ResultsPanel.currentPanel = undefined;
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try { d?.dispose(); } catch { }
    }
  }

  postResults(rows: any[], opts?: { truncated?: boolean; pageSize?: number }) {
    const msg = { type: "rows", rows, opts };
    try { this.panel.title = `AQL Results (${Array.isArray(rows) ? rows.length : 0})`; } catch { }
    this.lastMessage = msg;
    // Try to send immediately
    try { this.panel.webview.postMessage(msg); } catch { /* ignore */ }
    if (this.isReady) return;
    this.pendingMessages.push(msg);
    this.startRetry();
  }

  private startRetry() {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      if (this.isReady) { clearInterval(this.retryTimer!); this.retryTimer = undefined; return; }
      if (this.lastMessage) {
        try { this.panel.webview.postMessage(this.lastMessage); } catch { /* ignore */ }
      }
    }, 500);
  }

  private getHtml(webview: vscode.Webview) {
    const nonce = this.getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'results.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'results.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>AQL Results</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <header>
    <strong>AQL Results</strong>
    <div class="controls">
      <button id="exportJson">Export JSON</button>
      <button id="exportCsv">Export CSV</button>
      <label>Page size
        <select id="pageSize">
          <option>25</option>
          <option>50</option>
          <option selected>100</option>
          <option>200</option>
          <option>500</option>
        </select>
      </label>
      <button id="prevBtn">Prev</button>
      <span id="pageInfo" class="muted">1 / 1</span>
      <button id="nextBtn">Next</button>
    </div>
  </header>
  <div id="table">Waiting for results…</div>
  <script src="${scriptUri}" nonce="${nonce}"></script>
</body>
</html>`;
  }

  private getNonce() {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}


