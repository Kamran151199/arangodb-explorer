import * as vscode from "vscode";
import { ArangoClient } from "./arangodbClient";
import { ConnectionId, ConnectionProfile } from "./types";

class ConnectionItem extends vscode.TreeItem {
    constructor(
        public readonly profile: ConnectionProfile,
        public client: ArangoClient,
    ) {
        super(profile.name, vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = "arangodb.connection";
        this.description = profile.url;
        this.iconPath = new vscode.ThemeIcon("server");
    }
}

class DatabaseItem extends vscode.TreeItem {
    constructor(public readonly name: string) {
        super(name, vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = "arangodb.database";
        this.iconPath = new vscode.ThemeIcon("database");
    }
}

class CollectionItem extends vscode.TreeItem {
    constructor(public readonly name: string) {
        super(name, vscode.TreeItemCollapsibleState.None);
        this.contextValue = "arangodb.collection";
        this.iconPath = new vscode.ThemeIcon("file-submodule");
    }
}

export class ConnectionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | null | undefined>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | null | undefined> = this._onDidChangeTreeData.event;

    constructor(
        private context: vscode.ExtensionContext,
        private getClients: () => Map<ConnectionId, { profile: ConnectionProfile; client: ArangoClient }>
    ) { }

    refresh() { this._onDidChangeTreeData.fire(undefined); }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            // root: connections
            return Array.from(this.getClients().values()).map(({ profile, client }) => new ConnectionItem(profile, client));
        }

        if (element instanceof ConnectionItem) {
            const dbs = await element.client.listDatabases();
            return dbs.map((d) => new DatabaseItem(d));
        }

        if (element instanceof DatabaseItem) {
            // find owning connection item
            const all = Array.from(this.getClients().values());
            for (const { client } of all) {
                try {
                    const cols = await client.listCollectionsInDatabase(element.label as string);
                    return cols.map((c) => new CollectionItem(c.name));
                } catch { /* try next client */ }
            }
            return [];
        }

        return [];
    }
}


