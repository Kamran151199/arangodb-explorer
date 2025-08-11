import * as vscode from "vscode";
import { ArangoClient } from "./arangodbClient";
import { ConnectionsProvider } from "./tree";
import { ResultsPanel } from "./resultsPanel";
import { ConnectionId, ConnectionProfile } from "./types";

const CONNECTIONS_KEY = "arangodb:connections";
const ACTIVE_CONNECTION_KEY = "arangodb:activeConnectionId";
const LAST_DB_MAP_KEY = "arangodb:lastDbPerConnection";

type LastDbMap = Record<string, string | undefined>;

export async function activate(context: vscode.ExtensionContext) {
    const clients = new Map<ConnectionId, { profile: ConnectionProfile; client: ArangoClient }>();

    // Load saved profiles
    const saved: ConnectionProfile[] = context.globalState.get(CONNECTIONS_KEY, []);
    for (const p of saved) {
        const pw = await context.secrets.get(secretKey(p.id));
        if (!pw) continue;
        clients.set(p.id, { profile: p, client: new ArangoClient({ url: p.url, username: p.username, password: pw }) });
    }

    const provider = new ConnectionsProvider(context, () => clients);
    context.subscriptions.push(vscode.window.registerTreeDataProvider("arangodb.connections", provider));

    const setActiveConnectionId = async (id: string | undefined) => {
        await context.globalState.update(ACTIVE_CONNECTION_KEY, id);
    };
    const getActiveConnectionId = (): string | undefined => {
        return context.globalState.get<string | undefined>(ACTIVE_CONNECTION_KEY);
    };
    const getLastDbMap = (): LastDbMap => {
        return context.globalState.get<LastDbMap>(LAST_DB_MAP_KEY, {});
    };
    const setLastDbForConnection = async (connectionId: string, db: string | undefined) => {
        const map = getLastDbMap();
        map[connectionId] = db;
        await context.globalState.update(LAST_DB_MAP_KEY, map);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("arangodb.connect", async () => {
            const url = await vscode.window.showInputBox({ prompt: "ArangoDB URL", value: "http://localhost:8529", ignoreFocusOut: true });
            if (!url) return;
            const username = await vscode.window.showInputBox({ prompt: "Username", value: "root", ignoreFocusOut: true });
            if (!username) return;
            const password = await vscode.window.showInputBox({ prompt: "Password", password: true, ignoreFocusOut: true });
            if (password === undefined) return;
            const name = await vscode.window.showInputBox({ prompt: "Connection name", value: new URL(url).host, ignoreFocusOut: true });
            if (!name) return;

            const id = `${name}-${Date.now()}`;

            try {
                const client = new ArangoClient({ url, username, password });
                // Smoke test without requiring _system privileges
                await client.runAql('RETURN 1');

                const profile: ConnectionProfile = { id, name, url, username };
                clients.set(id, { profile, client });
                await saveProfiles(context, clients);
                await context.secrets.store(secretKey(id), password);
                provider.refresh();
                vscode.window.showInformationMessage(`Connected: ${name}`);
                if (!getActiveConnectionId()) {
                    await setActiveConnectionId(id);
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Connection failed: ${e?.message ?? e}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("arangodb.disconnect", async () => {
            const items = Array.from(clients.values()).map(({ profile }) => ({ label: profile.name, id: profile.id }));
            const pick = await vscode.window.showQuickPick(items, { placeHolder: "Select connection to remove" });
            if (!pick) return;
            clients.delete(pick.id);
            await saveProfiles(context, clients);
            await context.secrets.delete(secretKey(pick.id));
            provider.refresh();
            const active = getActiveConnectionId();
            if (active === pick.id) {
                await setActiveConnectionId(undefined);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("arangodb.newQuery", async () => {
            const doc = await vscode.workspace.openTextDocument({
                language: "aql",
                content: "RETURN 1  // replace with your AQL, e.g. FOR d IN my_collection LIMIT 10 RETURN d"
            });
            await vscode.window.showTextDocument(doc, { preview: false });
        })
    );

    // Set active connection
    context.subscriptions.push(
        vscode.commands.registerCommand("arangodb.setActiveConnection", async () => {
            if (clients.size === 0) {
                vscode.window.showWarningMessage("No ArangoDB connections. Run 'ArangoDB: Add Connection' first.");
                return;
            }
            const items = Array.from(clients.values()).map(({ profile }) => ({ label: profile.name, description: profile.url, id: profile.id }));
            const pick = await vscode.window.showQuickPick(items, { placeHolder: "Choose active connection" });
            if (!pick) return;
            await setActiveConnectionId(pick.id);
            vscode.window.setStatusBarMessage(`ArangoDB active connection: ${pick.label}`, 3000);
        })
    );

    // Set active database
    context.subscriptions.push(
        vscode.commands.registerCommand("arangodb.setActiveDatabase", async () => {
            const activeId = getActiveConnectionId();
            if (!activeId) { vscode.window.showWarningMessage("Set an active connection first."); return; }
            const entry = clients.get(activeId);
            if (!entry) { vscode.window.showWarningMessage("Active connection not found."); return; }
            const client = entry.client;
            let dbs: string[] = [];
            try { dbs = await client.listDatabases(); } catch { dbs = []; }
            let chosen: string | undefined;
            if (dbs.length > 0) {
                const pick = await vscode.window.showQuickPick(dbs.map(d => ({ label: d })), { placeHolder: "Choose a database" });
                if (!pick) return;
                chosen = pick.label;
            } else {
                chosen = await vscode.window.showInputBox({ prompt: "Target database (listing requires _system privileges)", value: "_system", ignoreFocusOut: true });
                if (!chosen) return;
            }
            client.useDatabase(chosen);
            await setLastDbForConnection(activeId, chosen);
            vscode.window.setStatusBarMessage(`ArangoDB active database: ${chosen}`, 3000);
        })
    );

    async function pickOrUseActiveConnection(): Promise<{ id: string; client: ArangoClient } | undefined> {
        if (clients.size === 0) {
            vscode.window.showWarningMessage("No ArangoDB connections. Run 'ArangoDB: Add Connection' first.");
            return;
        }
        const activeId = getActiveConnectionId();
        if (activeId && clients.has(activeId)) {
            return { id: activeId, client: clients.get(activeId)!.client };
        }
        const connectionPick = await vscode.window.showQuickPick(
            Array.from(clients.values()).map(({ profile }) => ({ label: profile.name, id: profile.id })),
            { placeHolder: "Choose a connection" }
        );
        if (!connectionPick) return;
        await setActiveConnectionId(connectionPick.id);
        return { id: connectionPick.id, client: clients.get(connectionPick.id)!.client };
    }

    async function ensureDatabaseSelected(connectionId: string, client: ArangoClient): Promise<string | undefined> {
        const remember = vscode.workspace.getConfiguration().get<boolean>("arangodb.rememberLastDatabase", true);
        const map = getLastDbMap();
        let chosenDb = remember ? map[connectionId] : undefined;
        if (!chosenDb) {
            let dbs: string[] = [];
            try { dbs = await client.listDatabases(); } catch { dbs = []; }
            if (dbs.length > 0) {
                const dbPick = await vscode.window.showQuickPick(dbs.map(d => ({ label: d })), { placeHolder: "Choose a database" });
                if (!dbPick) return;
                chosenDb = dbPick.label;
            } else {
                chosenDb = await vscode.window.showInputBox({ prompt: "Target database (listing requires _system privileges)", value: "_system", ignoreFocusOut: true });
                if (!chosenDb) return;
            }
            await setLastDbForConnection(connectionId, chosenDb);
        }
        client.useDatabase(chosenDb);
        return chosenDb;
    }

    function getCurrentQueryFromEditor(overrideText?: string, overrideRange?: vscode.Range): { editor: vscode.TextEditor, query: string, selectionRange: vscode.Range } | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage("Open an AQL document to run."); return; }
        const selection = typeof overrideText === 'string'
            ? overrideText
            : (editor.selection && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : editor.document.getText());
        const query = selection.trim();
        if (!query) { vscode.window.showWarningMessage("No AQL to run."); return; }
        const selectionRange = overrideRange
            ?? (editor.selection && !editor.selection.isEmpty ? new vscode.Range(editor.selection.start, editor.selection.end) : new vscode.Range(0, 0, editor.document.lineCount, 0));
        return { editor, query, selectionRange };
    }

    context.subscriptions.push(
        vscode.commands.registerCommand("arangodb.runQuery", async (arg?: any) => {
            const picked = await pickOrUseActiveConnection();
            if (!picked) return;
            const dbName = await ensureDatabaseSelected(picked.id, picked.client);
            if (!dbName) return;
            const overrideText = typeof arg === 'string' ? arg : (arg && typeof arg.text === 'string' ? arg.text : undefined);
            const info = getCurrentQueryFromEditor(overrideText);
            if (!info) return;
            const resultsView = ResultsPanel.show(context.extensionUri);
            try {
                const maxRows = vscode.workspace.getConfiguration().get<number>("arangodb.results.maxRows", 5000);
                const pageSize = vscode.workspace.getConfiguration().get<number>("arangodb.results.defaultPageSize", 100);
                const { rows, hasMore } = await picked.client.runAqlWithLimit(info.query, Math.max(100, maxRows));
                // Send a tiny warm-up message to ensure webview channel is active
                resultsView.postResults([], { truncated: false, pageSize });
                // Then send actual rows
                resultsView.postResults(rows, { truncated: hasMore, pageSize });
                vscode.window.setStatusBarMessage(`AQL returned ${rows.length}${hasMore ? '+' : ''} row(s)`, 3000);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Query failed: ${e?.message ?? e}`);
            }
        })
    );

    // Run from cursor to next boundary
    context.subscriptions.push(
        vscode.commands.registerCommand("arangodb.runQueryFromHere", async () => {
            const picked = await pickOrUseActiveConnection();
            if (!picked) return;
            const dbName = await ensureDatabaseSelected(picked.id, picked.client);
            if (!dbName) return;
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showWarningMessage("Open an AQL document to run."); return; }
            const chunk = getChunkFromHere(editor);
            if (!chunk) { vscode.window.showWarningMessage("No AQL chunk found from cursor."); return; }
            const info = getCurrentQueryFromEditor(chunk.text, chunk.range);
            if (!info) return;
            const resultsView = ResultsPanel.show(context.extensionUri);
            try {
                const maxRows = vscode.workspace.getConfiguration().get<number>("arangodb.results.maxRows", 5000);
                const pageSize = vscode.workspace.getConfiguration().get<number>("arangodb.results.defaultPageSize", 100);
                const { rows, hasMore } = await picked.client.runAqlWithLimit(info.query, Math.max(100, maxRows));
                resultsView.postResults(rows, { truncated: hasMore, pageSize });
                vscode.window.setStatusBarMessage(`AQL returned ${rows.length}${hasMore ? '+' : ''} row(s)`, 3000);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Query failed: ${e?.message ?? e}`);
            }
        })
    );

    function getChunkFromHere(editor: vscode.TextEditor): { range: vscode.Range; text: string } | undefined {
        const lineCount = editor.document.lineCount;
        const cursor = editor.selection.active;
        const startLine = cursor.line;
        // Find end boundary: next blank or line with semicolon end
        let endLine = startLine;
        for (let i = startLine; i < lineCount; i++) {
            const t = editor.document.lineAt(i).text;
            endLine = i;
            if (t.trim().endsWith(';')) { break; }
            if (t.trim().length === 0 && i !== startLine) { break; }
        }
        const range = new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine, editor.document.lineAt(endLine).text.length));
        const text = editor.document.getText(range).trim();
        if (!text) return undefined;
        return { range, text };
    }

    // Inline results (insert below selection)
    context.subscriptions.push(
        vscode.commands.registerCommand("arangodb.runQueryInline", async (arg?: any) => {
            const picked = await pickOrUseActiveConnection();
            if (!picked) return;
            const dbName = await ensureDatabaseSelected(picked.id, picked.client);
            if (!dbName) return;
            const overrideText = typeof arg === 'string' ? arg : (arg && typeof arg.text === 'string' ? arg.text : undefined);
            const info = getCurrentQueryFromEditor(overrideText);
            if (!info) return;
            try {
                const rows = await picked.client.runAql(info.query);
                const maxRows = vscode.workspace.getConfiguration().get<number>("arangodb.inlineResults.maxRows", 50);
                const clipped = rows.slice(0, Math.max(1, maxRows));
                const header = `// AQL Result (${rows.length} rows)\n`;
                const body = JSON.stringify(clipped, null, 2).split("\n").map(l => `// ${l}`).join("\n");
                const footer = rows.length > clipped.length ? `\n// … truncated to ${clipped.length} rows` : "";
                const block = `\n${header}${body}${footer}\n`;
                await info.editor.edit(editBuilder => {
                    const insertPos = info.selectionRange.end;
                    editBuilder.insert(insertPos, block);
                });

                // Show ephemeral inline decoration panel (hoverable)
                const decorationType = vscode.window.createTextEditorDecorationType({
                    after: { margin: '0 0 0 12px', color: new vscode.ThemeColor('descriptionForeground') }
                });
                info.editor.setDecorations(decorationType, [
                    { range: new vscode.Range(info.selectionRange.end, info.selectionRange.end), hoverMessage: new vscode.MarkdownString('AQL results inserted below. Open Results view for table features.') }
                ]);
                setTimeout(() => decorationType.dispose(), 4000);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Query failed: ${e?.message ?? e}`);
            }
        })
    );

    // CodeLens provider: adds Run/Inline on each query chunk
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ language: 'aql' }, new (class implements vscode.CodeLensProvider {
            provideCodeLenses(document: vscode.TextDocument): vscode.ProviderResult<vscode.CodeLens[]> {
                const lenses: vscode.CodeLens[] = [];
                const chunks = splitAqlIntoChunks(document);
                for (const c of chunks) {
                    lenses.push(new vscode.CodeLens(c.range, {
                        title: 'Run AQL', command: 'arangodb.runQuery', arguments: [{ text: c.text }]
                    }));
                    lenses.push(new vscode.CodeLens(c.range, {
                        title: 'Inline Results', command: 'arangodb.runQueryInline', arguments: [{ text: c.text }]
                    }));
                }
                return lenses;
            }
        })())
    );

    function splitAqlIntoChunks(document: vscode.TextDocument): { range: vscode.Range; text: string }[] {
        const chunks: { range: vscode.Range; text: string }[] = [];
        let startLine = 0;
        let buffer: string[] = [];
        const flush = (endLineExclusive: number) => {
            const text = buffer.join('\n').trim();
            if (text.length > 0) {
                const range = new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLineExclusive - 1, document.lineAt(endLineExclusive - 1).text.length));
                chunks.push({ range, text });
            }
            buffer = [];
        };
        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            buffer.push(lineText);
            const trimmed = lineText.trim();
            const isBoundary = trimmed.endsWith(';') || trimmed.length === 0;
            if (isBoundary) {
                flush(i + 1);
                startLine = i + 1;
            }
        }
        if (buffer.length > 0) flush(document.lineCount);
        return chunks;
    }

    // Completion for AQL variables after dot and collections after IN
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider({ language: 'aql' }, {
            async provideCompletionItems(document, position) {
                const picked = await pickOrUseActiveConnection();
                if (!picked) return;
                const dbName = await ensureDatabaseSelected(picked.id, picked.client);
                if (!dbName) return;

                const text = document.getText();
                const lineText = document.lineAt(position.line).text.substring(0, position.character);

                const dotMatch = /([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(lineText);
                if (dotMatch) {
                    const variable = dotMatch[1];
                    const regex = /FOR\s+([A-Za-z_][A-Za-z0-9_]*)\s+IN\s+([A-Za-z0-9_:-]+)/gi;
                    let m;
                    let collection;
                    while ((m = regex.exec(text))) {
                        if (m[1] === variable) { collection = m[2]; }
                    }
                    if (collection) {
                        try {
                            const attrs = await picked.client.sampleAttributes(collection, 100);
                            return attrs.map(a => new vscode.CompletionItem(a, vscode.CompletionItemKind.Field));
                        } catch { }
                    }
                }

                const before = lineText.toUpperCase();
                if (/\bIN\s+[A-Z0-9_:-]*$/.test(before)) {
                    try {
                        const cols = await picked.client.listCollections();
                        return cols.map(c => new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Class));
                    } catch { }
                }
                return;
            }
        }, '.')
    );
}

export function deactivate() { }

async function saveProfiles(context: vscode.ExtensionContext, clients: Map<ConnectionId, { profile: ConnectionProfile }>) {
    const profiles = Array.from(clients.values()).map(({ profile }) => profile);
    await context.globalState.update(CONNECTIONS_KEY, profiles);
}

function secretKey(id: string) { return `arangodb:password:${id}`; }


