// Client -> Server

export const enum ClientOp {
    Join = 'join',
    Leave = 'leave',
    Call = 'call',
}

export type ClientMessageMap = {
    [ClientOp.Join]: { token: string };
    [ClientOp.Leave]: { channel: string };
    [ClientOp.Call]: { channel: string, feature: Feature, call: string };
};

export const enum Feature {
    Claims = 'claims',
}

export const enum Call {
    ClaimsAcquire = 'claims:acquire',
    ClaimsRelease = 'claims:release',
}

export type ClientCalls = {
    [Call.ClaimsAcquire]: { resource: string, force: boolean };
    [Call.ClaimsRelease]: { resource: string };
};

export type ClientMessage = ClientMessageMap[ClientOp];

// Server -> Client

export type ServerMessage =
    | { event: string, channel?: string, data?: unknown }
    | { res: number, data?: unknown }
    | { res: number, error: ErrorCode, details?: unknown }
    ;

export enum ErrorCode {
    Failure = 0,
    Unsupported = 1,
    InvalidToken = 2,
    NotSubscribed = 3,
    FeatureDisabled = 4,
}

export const enum ServerEvent {
    ChannelMessage = 'channel:message',
    ChannelClaims = 'channel:claims',
    ChannelPresence = 'channel:presence',

    // Local only
    SocketUp = 'socket:up',
    SocketDown = 'socket:down',
    ChannelUp = 'channel:up',
    ChannelDown = 'channel:down',
}

// Request -> Response mapping

export type ServerResultFor<O extends ClientOp, T extends Call> = ServerResultMap<T>[O];

export type ServerResultMap<C extends Call> = {
    [ClientOp.Join]: void;
    [ClientOp.Leave]: void;
    [ClientOp.Call]: CallResultMap[C];
};

export type CallResultMap = {
    [Call.ClaimsAcquire]: boolean;
    [Call.ClaimsRelease]: boolean;
};

// Miscellaneous types

export type Claims = {
    claims: { [resource: string]: string | undefined; };
    own: string[];
}
