import { Features } from '../token';
import { Call, type Claims, ClientCalls, ClientOp, Feature, ServerEvent, ServerResultFor } from '../proto';
import { EventEmitter } from './emitter';
import { NO_CLAIMS, simulate_claim_acquire, simulate_claim_release } from './claims';
import type { Service } from './service';
import type { Subscription } from './subscription';

/**
 * A Channel is a single Hedwig channel. A single instance is shared by all
 * subscriptions that use the same channel name.
 */
/** @internal */
export class Channel extends EventEmitter {
    /** The abort controller used to cancel operations on this channel on close */
    #abort = new AbortController();

    /** Whether the channel is currently connected */
    #isConnected = false;

    /** The set of subscriptions using this channel */
    #subscriptions = new Set<Subscription>();

    /** The features of this channel */
    features: Features = {};

    constructor(
        readonly name: string,
        private readonly service: Service,
    ) {
        super();

        // Keep a local copy of the presence if subscriptions are added later.
        this.addEventListener(ServerEvent.ChannelPresence, ({ detail }: CustomEvent<string[]>) => {
            this.#presence = detail;
        });

        // Keep a local copy of the claims if subscriptions are added later.
        this.addEventListener(ServerEvent.ChannelClaims, ({ detail }: CustomEvent<Claims>) => {
            this.#claims = detail;
        });

        // When the channel is disconnected, reset the presence and claims.
        this.addEventListener(ServerEvent.ChannelDown, () => {
            this.handleEvent(ServerEvent.ChannelPresence, []);
            this.handleEvent(ServerEvent.ChannelClaims, NO_CLAIMS);
        });
    }

    /** Whether the channel is currently connected. */
    get isConnected(): boolean {
        return this.#isConnected;
    }

    /** Sets the connected state of this channel. */
    set isConnected(value: boolean) {
        if (this.#isConnected !== value) {
            this.#isConnected = value;
            if (value) {
                this.handleEvent(ServerEvent.ChannelUp, undefined);
            } else {
                this.handleEvent(ServerEvent.ChannelDown, undefined);
            }
        }
    }

    /** Adds a subscription to this channel. */
    addSubscription(sub: Subscription) {
        this.#subscriptions.add(sub);

        // Joining a channel that is already connected changes none of its
        // state, so no event would tell the new subscription about it.
        if (this.#isConnected) {
            sub.dispatchEvent(ServerEvent.ChannelUp, undefined);
            sub.dispatchEvent(ServerEvent.ChannelPresence, this.#presence);
            sub.dispatchEvent(ServerEvent.ChannelClaims, this.#claims);
        }
    }

    /** Removes a subscription from this channel. */
    removeSubscription(sub: Subscription): boolean {
        return this.#subscriptions.delete(sub);
    }

    /** Checks if there are any subscriptions for this channel. */
    hasSubscriptions(): boolean {
        return this.#subscriptions.size > 0;
    }

    /** Dispatches an event to this channel and all subscriptions. */
    handleEvent(event: string, data: unknown) {
        this.dispatchEvent(event, data);
        for (const sub of this.#subscriptions) {
            sub.dispatchEvent(event, data);
        }
    }

    /** Sends a call to the server and returns a promise that resolves to the server's response. */
    call<C extends Call>(op: C, data: ClientCalls[C]): Promise<ServerResultFor<ClientOp.Call, C>> {
        const [feature, call] = op.split(':');
        return this.service.send(ClientOp.Call, {
            ...data,
            channel: this.name,
            feature: feature as Feature,
            call,
        });
    }

    /** Closes this channel. */
    close() {
        this.#abort.abort();
    }

    /** CLAIMS */

    #claims: Claims = NO_CLAIMS;

    get claims(): Claims {
        return this.#claims;
    }

    claimAcquire(resource: string, force: boolean): Promise<boolean> {
        if (this.isConnected) {
            return this.call(Call.ClaimsAcquire, { resource, force });
        }
        return Promise.resolve(simulate_claim_acquire(this, this.#claims, resource, force, this.features.claims?.user ?? ""));
    }

    claimRelease(resource: string): Promise<boolean> {
        if (this.isConnected) {
            return this.call(Call.ClaimsRelease, { resource });
        }
        return Promise.resolve(simulate_claim_release(this, this.#claims, resource));
    }

    /** PRESENCE */

    #presence: string[] = [];

    get presence(): string[] {
        return this.#presence;
    }
}
