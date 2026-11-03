import { type Claims, ServerEvent } from '../proto';
import { EventEmitter } from './emitter';

/** The value that is returned when no claims are available */
export const NO_CLAIMS: Claims = { claims: {}, own: [] };

export function simulate_claim_acquire(eventEmitter: EventEmitter, claims: Claims, resource: string, force: boolean, username: string): boolean {
    if (!force && claims.claims[resource]) {
        return false;
    }

    claims.claims[resource] = username;
    if (!claims.own.includes(resource)) {
        claims.own.push(resource);
    }

    eventEmitter.dispatchEvent(ServerEvent.ChannelClaims, claims);
    return true;
}

export function simulate_claim_release(eventEmitter: EventEmitter, claims: Claims, resource: string): boolean {
    if (!claims.own.includes(resource)) {
        return false;
    }

    delete claims.claims[resource];
    claims.own.splice(claims.own.indexOf(resource), 1);

    eventEmitter.dispatchEvent(ServerEvent.ChannelClaims, claims);
    return true;
}
