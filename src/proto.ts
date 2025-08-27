// Client -> Server

import { ServerError } from "./service";
import { Result } from "./util";

export const enum ClientOp {
    Join = 'join',
    Leave = 'leave',
    Call = 'call',
}

export type ClientMessageMap = {
    [ClientOp.Join]: { token: string };
    [ClientOp.Leave]: { channel: string };
    [ClientOp.Call]: { channel: string, feature: string, call: string };
};

export const enum Feature {
    Claims = 'claims',
    State = 'state',
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
    InvalidToken = 1,
    NotSubscribed = 2,
    FeatureDisabled = 3,
    StateWrongRevision = 110,
}

// Request -> Response mapping

export type ServerResultFor<O extends ClientOp, T> = ServerResultMap<T>[O];

export type ServerResultMap<T> = {
    [ClientOp.Join]: Result<void, ServerError<ErrorCode, unknown>>;
    [ClientOp.Leave]: Result<void, ServerError<ErrorCode, unknown>>;
    [ClientOp.Call]: Result<unknown, ServerError<ErrorCode, unknown>>;
};

export type Claims = {
    claims: { [resource: string]: string | undefined; };
    own: string[];
}
