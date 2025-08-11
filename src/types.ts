export type ConnectionId = string;

export interface ConnectionProfile {
    id: ConnectionId;
    name: string;            // Friendly label shown in the tree
    url: string;             // e.g. http://localhost:8529
    username: string;
    // password is stored in SecretStorage under key `arangodb:password:${id}`
}

export interface AqlResultRow {
    [key: string]: unknown;
}


