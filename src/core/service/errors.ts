import { ErrorCode, ErrorCodeName } from '../proto';

/** The value that is thrown whenever attempting to use a disconnected socket or channel */
export const ERR_DISCONNECTED = Symbol('ERR_DISCONNECTED');

/**
 * A ServerError wraps the error code and any additional detail
 * returned by the server when an operation fails.
 */
export class ServerError<C extends ErrorCode, T> extends Error {
    constructor(readonly code: C, readonly detail: T) {
        super(`[E${code}] ${ErrorCodeName.get(code) ?? 'Unknown'}`);
        this.name = this.constructor.name;
    }
}
