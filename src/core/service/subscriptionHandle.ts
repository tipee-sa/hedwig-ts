import { type Claims } from '../proto';
import type { Subscription } from './subscription';

/**
 * A SubscriptionHandle is the public API for a subscription.
 * It is returned by the [`Service.subscribe`] method.
 */
export class SubscriptionHandle {
    /** The internal subscription state */
    #subscription: Subscription;

    /** @internal */
    constructor(subscription: Subscription) {
        this.#subscription = subscription;
    }

    /** Returns whether the subscription is canceled. */
    get canceled(): boolean {
        return this.#subscription.signal.aborted;
    }

    get isConnected(): boolean {
        return this.#subscription.isConnected;
    }

    /** Adds an event listener to the subscription. */
    addEventListener<E>(
        type: string,
        callback: (ev: CustomEvent<E>) => void,
        options?: AddEventListenerOptions
    ): void {
        if (this.canceled) {
            throw new Error('Cannot add event listener to a canceled subscription');
        }
        this.#subscription.addEventListener(type, callback as EventListener, options);
    }

    /* CLAIMS */

    get claims(): Claims {
        return this.#subscription.claims;
    }

    claimAcquire(resource: string, force: boolean): Promise<boolean> {
        return this.#subscription.claimAcquire(resource, force);
    }

    claimRelease(resource: string): Promise<boolean> {
        return this.#subscription.claimRelease(resource);
    }

    /* PRESENCE */

    get presence(): string[] {
        return this.#subscription.channel?.presence ?? [];
    }
}
