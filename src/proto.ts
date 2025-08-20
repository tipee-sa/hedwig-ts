// Client -> Server

import { ServerError } from "./service";
import { Result } from "./util";

export const enum ClientOp {
    Join = 'join',
    Leave = 'leave',
}

export type ClientMessageMap = {
    [ClientOp.Join]: { token: string };
    [ClientOp.Leave]: { channel: string };
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
};
