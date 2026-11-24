import { HedwigToken } from '../token';
import { type Claims, ServerEvent } from '../proto';
import { abortable, sleep } from '../util';
import { Logger } from '../logger';
import { EventEmitter } from './emitter';
import { noClaims, simulate_claim_acquire, simulate_claim_release } from './claims';
import type { Channel } from './channel';
import type { Service } from './service';
import type { SubscriptionHandle } from './subscriptionHandle';

/** A function that produce a token for a subscription */
export type Authorizer = (s: AbortSignal) => string | Promise<string>;

/**
 * A Subscription is a single lease on a channel. `useChannel` creates one each
 * time its effect runs, and binds it to its handle, which outlives it. It is
 * responsible for managing the lifetime of the subscription, including
 * renewing the token and handling reconnection.
 */
/** @internal */
export class Subscription extends EventEmitter {
    static #nextSubscriptionId = 0;

    /** The unique ID of this subscription */
    readonly #subscriptionId: number = ++Subscription.#nextSubscriptionId;

    /** The logger instance for this subscription */
    readonly #logger: Logger;

    constructor(
        readonly service: Service,
        readonly signal: AbortSignal,
        readonly authorizer: Authorizer,
        readonly handle: SubscriptionHandle,
    ) {
        super();
        this.#logger = service.makeLogger(`S:${this.#subscriptionId}`);
        handle.bind(this);
        this.#run(); // Async

        // Discard the stand-in claims once the channel delivers real ones. Not
        // on the events emitted by the local emulation, which carry
        // `#localClaims` itself and must keep it.
        this.addEventListener(ServerEvent.ChannelClaims, ({ detail }) => {
            if (detail !== this.#localClaims) {
                this.#localClaims = noClaims();
            }
        });
    }

    /** Dispatches to this subscription's listeners, then to its handle's. */
    override dispatchEvent(event: string, detail: unknown): boolean {
        const result = super.dispatchEvent(event, detail);
        this.handle.relay(this, event, detail);
        return result;
    }

    /** The bound channel, if any */
    get channel(): Channel | undefined {
        return this.service.getChannel(this);
    }

    get isConnected(): boolean {
        return this.channel?.isConnected ?? false;
    }

    /** The main lifecycle of this subscription, will run until terminated. */
    async #run(): Promise<void> {
        try {
            this.#logger.debug('Subscription created');

            // Wait until the service is connected before proceeding.
            await this.service.upPromise(this.signal);

            // Retrieve the initial token for this subscription.
            let token = await this.#fetchToken(undefined, 10);
            this.signal.throwIfAborted();
            this.service.updateSubscription(this, token);

            // From now on, every time the socket is established, we will
            // contribute our token to the set of recovered tokens, it is
            // still valid. If it is not valid anymore,, we'll record this
            // as this means the we need to re-fetch a token ASAP.
            let tokenWasForgotten = false;
            this.service.addEventListener(ServerEvent.SocketUp, ({ detail: tokens }) => {
                if (token.isValid) {
                    if (!tokens.has(token.channel)) {
                        tokens.set(token.channel, token);
                    }
                } else {
                    tokenWasForgotten = true;
                }
            }, { signal: this.signal });

            // Keep the subscription alive until canceled.
            // The outer loop will iterate each time the service experience a
            // disconnect-reconnect cycle.
            while (!this.signal.aborted) {
                await this.service.upPromise(this.signal);
                const disconnected = this.service.downSignal(this.signal);

                // The inner loop will run as long as the service stays
                // connected. It will refresh the token whenever it is about
                // to expire.
                while (!disconnected.aborted) {
                    const tokenExpiration = tokenWasForgotten ? null : AbortSignal.timeout(token.subscriptionExpiration - Date.now());
                    const signal = AbortSignal.any([
                        this.signal,
                        disconnected,
                        ...(tokenExpiration ? [tokenExpiration] : []),
                    ]);

                    try {
                        if (!tokenWasForgotten) {
                            // Renew at 90% of the lifetime, but at least 5 seconds before expiration.
                            const renewalAt = token.subscriptionExpiration - Math.max(token.subscriptionLifetime * 0.1, 5000);
                            const delay = Math.max(0, renewalAt - Date.now());
                            if (delay > 0) {
                                await sleep(delay, signal);
                            }
                        }

                        this.#logger.debug('Renewing subscription token');
                        token = await this.#fetchToken(signal);
                        this.signal.throwIfAborted();
                        tokenWasForgotten = false; // Reset the flag after a successful fetch
                        this.service.updateSubscription(this, token);
                    }
                    catch (err) {
                        if (tokenExpiration?.aborted) {
                            this.#logger.warn('Token renewal timed out, subscription will be canceled');
                            this.service.updateSubscription(this, null);
                        } else if (disconnected.aborted) {
                            break; // Exit the inner loop, wait for reconnection
                        } else {
                            throw err;
                        }
                    }
                }
            }
        }
        catch (err) {
            if (!this.signal.aborted) {
                this.#logger.error('An unexpected error caused the subscription to fail:', err);
            }
        }
        finally {
            // Unregister the subscription from the service, at this point it
            // is effectively dead.
            this.service.removeSubscription(this);
            this.#logger.debug('Subscription canceled');
        }
    }

    /** Fetches the authorization token using the channel `authorizer`. */
    async #fetchToken(signal?: AbortSignal, maxAttempts: number = Number.MAX_SAFE_INTEGER): Promise<HedwigToken> {
        signal = signal ? AbortSignal.any([this.signal, signal]) : this.signal;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            this.signal.throwIfAborted();

            try {
                // The authorizer may ignore its signal: without the race, a
                // canceled subscription would wait for it, possibly forever,
                // before leaving the service. Only the cancellation ends the
                // wait: a renewal that answers after the token expired still
                // brings a token to join with.
                const rawToken = await abortable(
                    Promise.resolve(this.authorizer(AbortSignal.any([signal, AbortSignal.timeout(5000)]))),
                    this.signal,
                );
                const token = new HedwigToken(rawToken);
                this.#logger.prefix = `S:${this.#subscriptionId}:${token.channel}`;
                return token;
            }
            catch (err: any) {
                if (signal.aborted) throw err;
                this.#logger.error('Authorization failed:', err);
            }

            const delay = 500 * (Math.random() + 2 ** Math.min(6, attempt)); // Exponential backoff, max ~30s
            this.#logger.debug('Retrying authorization in %d ms', delay);
            await sleep(delay, signal);
        }
        throw new Error('Authorization failed after too many attempts');
    }

    /* CLAIMS */

    /**
     * Stand-in claims, used only while this subscription is not bound to a
     * channel: before its first token tells it which channel it belongs to, or
     * after it was detached. Acquire and release are emulated on it locally,
     * with an empty owner since the user is unknown too; nothing is sent to the
     * server. Once bound, `claims` reads the channel's state instead, and
     * this is discarded on the first claims the channel delivers.
     */
    #localClaims: Claims = noClaims();

    get claims(): Claims {
        return this.channel?.claims ?? this.#localClaims;
    }

    claimAcquire(resource: string, force: boolean): Promise<boolean> {
        const channel = this.channel;
        if (channel) {
            return channel.claimAcquire(resource, force);
        } else {
            return Promise.resolve(simulate_claim_acquire(this, this.#localClaims, resource, force, ""));
        }
    }

    claimRelease(resource: string): Promise<boolean> {
        const channel = this.channel;
        if (channel) {
            return channel.claimRelease(resource);
        } else {
            return Promise.resolve(simulate_claim_release(this, this.#localClaims, resource));
        }
    }
}
