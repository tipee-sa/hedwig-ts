import { type Claims } from '../proto';
import { EventEmitter } from './emitter';
import { noClaims } from './claims';
import type { Subscription } from './subscription';

/**
 * A SubscriptionHandle is the public API for a subscription.
 * It is returned by `useChannel`.
 *
 * Listeners belong to the handle, which relays them the events of the
 * subscription it stands for. While that subscription is missing or canceled,
 * the handle reads as not connected, with no presence and no claims, and
 * acquiring a claim resolves to `false`.
 */
export class SubscriptionHandle {
    /** The subscription the handle stands for, if any */
    #subscription: Subscription | null = null;

    /** The handle's listeners */
    readonly #emitter: EventEmitter = new (class extends EventEmitter {})();

    /** @internal */
    bind(subscription: Subscription): void {
        this.#subscription = subscription;
    }

    /** @internal */
    relay(from: Subscription, event: string, detail: unknown): void {
        if (from === this.#subscription && !from.signal.aborted) {
            this.#emitter.dispatchEvent(event, detail);
        }
    }

    /** The subscription the handle stands for, unless it is missing or canceled */
    get #live(): Subscription | null {
        const subscription = this.#subscription;
        return subscription !== null && !subscription.signal.aborted ? subscription : null;
    }

    /**
     * Returns whether the subscription the handle stands for is canceled.
     *
     * @deprecated The handle outlives its subscriptions: when `useChannel`
     * subscribes again with the same handle, as StrictMode does right after
     * mounting, the effects of child components run in between and read
     * `true`. Listeners can be added regardless, as the handle relays the
     * events of each subscription it is bound to.
     */
    get canceled(): boolean {
        return this.#subscription?.signal.aborted ?? false;
    }

    get isConnected(): boolean {
        return this.#live?.isConnected ?? false;
    }

    /**
     * Adds an event listener to the handle. It receives the events of the
     * subscription the handle stands for when they happen.
     */
    addEventListener<E>(
        type: string,
        callback: (ev: CustomEvent<E>) => void,
        options?: AddEventListenerOptions
    ): void {
        this.#emitter.addEventListener(type, callback as (e: CustomEvent) => void, options);
    }

    /* CLAIMS */

    get claims(): Claims {
        return this.#live?.claims ?? noClaims();
    }

    claimAcquire(resource: string, force: boolean): Promise<boolean> {
        return this.#live?.claimAcquire(resource, force) ?? Promise.resolve(false);
    }

    claimRelease(resource: string): Promise<boolean> {
        // Goes through the subscription even once canceled: on unmount, the
        // parent's `useChannel` cancels it before the child releases its claim.
        return this.#subscription?.claimRelease(resource) ?? Promise.resolve(false);
    }

    /* PRESENCE */

    get presence(): string[] {
        return this.#live?.channel?.presence ?? [];
    }
}
