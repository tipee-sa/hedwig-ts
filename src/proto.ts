// Client -> Server

import { ServerError } from "./service";
import { Result } from "./util";

export const enum ClientOp {
    Join = 'j',
    Leave = 'l',
    SetState = 's',
    Suspend = 'z',
    Resume = 'w',
}

export type ClientMessageMap = {
    [ClientOp.Join]: { [ClientOp.Join]: string[] };
    [ClientOp.Leave]: { [ClientOp.Leave]: string[] };
    [ClientOp.SetState]: { [ClientOp.SetState]: [string, unknown, string | null] };
    [ClientOp.Suspend]: ClientOp.Suspend;
    [ClientOp.Resume]: ClientOp.Resume;
};

export type ClientMessage = ClientMessageMap[ClientOp];

// Server -> Client

export const enum ServerOp {
    Message = 'm',
    Presence = 'p',
    State = 's',
    Response = 'r',
    ChannelClosed = 'k',
}

export type ServerMessageMap = {
    [ServerOp.Message]: { [ServerOp.Message]: [string, unknown] }; // [channel, payload]
    [ServerOp.Presence]: { [ServerOp.Presence]: [string, string[]] }; // [channel, payload]
    [ServerOp.State]: { [ServerOp.State]: [string, [unknown, string]] }; // [channel, [payload, revision]]
    [ServerOp.Response]: { [ServerOp.Response]: [number, ServerResult<unknown, unknown> | undefined] }; // [operation ID, result]
    [ServerOp.ChannelClosed]: { [ServerOp.ChannelClosed]: string }; // channel
};

export type ServerMessage = ServerMessageMap[ServerOp];

export type ServerResult<R, E> =
    | { [ServerResultType.Success]: R }
    | { [ServerResultType.Error]: [ErrorCode, string, E] }
    ;

export const enum ServerResultType {
    Success = 's',
    Error = 'e',
}

export const enum ErrorCode {
    Failure = 0,
    WrongRevision = 1,
}

// Request -> Response mapping

export type ServerResultFor<O extends ClientOp, T> = ServerResultMap<T>[O];

export type ServerResultMap<T> = {
    [ClientOp.Join]: Result<void, ServerError<ErrorCode, unknown>>;
    [ClientOp.Leave]: Result<void, ServerError<ErrorCode, unknown>>;
    [ClientOp.SetState]: Result<void,
        ServerError<ErrorCode.WrongRevision, { r: string, v?: T }>
        | ServerError<Exclude<ErrorCode, ErrorCode.WrongRevision>, unknown>>;
    [ClientOp.Suspend]: Result<void, ServerError<ErrorCode, unknown>>;
    [ClientOp.Resume]: Result<void, ServerError<ErrorCode, unknown>>;
};
