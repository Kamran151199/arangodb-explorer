# ArangoDB Explorer (VS Code)

Minimal extension to browse and query ArangoDB with AQL.

## Features
- Save multiple connections (passwords stored in SecretStorage)
- Tree view of databases and collections
- Run AQL from the active editor (selection or entire doc)
- Results shown in a simple JSON table webview

## Commands
- **ArangoDB: Add Connection** — create a connection profile.
- **ArangoDB: Remove Connection** — delete a profile and its stored secret.
- **ArangoDB: New AQL Query** — open a new AQL document.
- **ArangoDB: Run AQL** — run current selection or whole file.

## Getting Started
1. `npm install`
2. `npm run watch` (or `npm run build`)
3. Press `F5` to launch the Extension Development Host.
4. In the *ArangoDB* view (Explorer sidebar), click **ArangoDB: Add Connection**.

## Notes
- Requires network access to your ArangoDB server (HTTP).
- Tested with `arangojs@8`. For clusters/advanced auth, expand the client wrapper.
- This is an MVP meant to be extended: saved queries, bind variables, query history, notebook cells, etc.
