import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Context } from "./context";
import { Authorizer, SubscriptionHandle } from "./service";
import { Claims, ServerEvent } from "./proto";

/** @internal */
function useAbortableEffect(
    effect: (signal: AbortSignal) => (() => void) | void,
    deps: React.DependencyList,
): void {
    useEffect(() => {
        const ctrl = new AbortController();
        const cleanup = effect(ctrl.signal);
        return () => {
            if (typeof cleanup === 'function') {
                cleanup();
            }
            ctrl.abort();
        };
    }, deps);
}

/**
 * useChannel sets up a subscription to an Hedwig channel.
 *
 * The given `authorizer` must produce an authorization token (usually by
 * calling the backend server) that will be used to join the channel. This
 * token will be automatically refreshed when it expires.
 */
export function useChannel(
    authorizer: Authorizer,
    deps: React.DependencyList,
): SubscriptionHandle {
    const service = useContext(Context);
    if (service === null) {
        throw new Error('useChannel must be used within a HedwigProvider');
    }

    const ctrl = useRef<AbortController | null>(null);
    if (ctrl.current === null) {
        ctrl.current = new AbortController();
    }

    const [subscription, setSubscription] = useState<SubscriptionHandle>(
        () => service.subscribe(ctrl.current!.signal, authorizer),
    );

    useEffect(
        () => {
            if (ctrl.current!.signal.aborted) {
                ctrl.current = new AbortController();
                setSubscription(service.subscribe(ctrl.current.signal, authorizer));
            }
            return () => ctrl.current?.abort();
        },
        [service, ...deps], // Not including `authorizer`, as its dependencies should already be in `deps`
    );

    return subscription;
}

/**
 * useChannelStatus returns whether the given subscription is currently connected
 * to the server.
 */
export function useChannelStatus(
    subscription: SubscriptionHandle,
): boolean {
    const [state, setState] = useState<boolean>(() => subscription.isConnected);

    useAbortableEffect(
        (signal) => {
            setState(subscription.isConnected);
            subscription.addEventListener(ServerEvent.ChannelUp, () => setState(subscription.isConnected), { signal });
            subscription.addEventListener(ServerEvent.ChannelDown, () => setState(subscription.isConnected), { signal });
        },
        [subscription]
    );

    return state;
}

/**
 * useChannelEvent sets up a listener for events on the given subscription.
 *
 * # Offline behavior
 *
 * When offline, no events are ever received.
 */
export function useChannelEvent(
    subscription: SubscriptionHandle,
    handler: (event: unknown) => void,
    deps: React.DependencyList,
) {
    useAbortableEffect(
        (signal) => subscription.addEventListener(ServerEvent.ChannelEvent, ({ detail }) => handler(detail), { signal }),
        [subscription, ...deps], // Not including `handler`, as its dependencies should already be in `deps`
    );
}

/**
 * useChannelPresence returns the presence set for the channel.
 *
 * # Offline behavior
 *
 * When offline, the presence set is an empty array.
 */
export function useChannelPresence(
    subscription: SubscriptionHandle
): string[] {
    const [presence, setPresence] = useState<string[]>((() => subscription.presence));

    useAbortableEffect(
        (signal) => {
            setPresence(subscription.presence);
            subscription.addEventListener<string[]>(ServerEvent.ChannelPresence, ({ detail }) => setPresence(detail), { signal });
        },
        [subscription]
    );

    return presence;
}

/**
 * useChannelClaim returns the owner of the given resource as well as a handle
 * used to acquire and release the claim.
 *
 * The retuned values are `[owner, owned, handle]`.
 *
 * - `owner` is the current owner of the resource (might by null). It usually
 *   matches whatever user identifier was defined by the server issuing the
 *   token, but might be an empty string when offline (see below).
 *
 * - `owned` is true if and only if the current socket owns the claim. It is
 *   possible for `owner` to match the current owner but `owned` to be false
 *   if multiple sockets are active for the same user.
 *
 * - `handle` is the object used to acquire and release the claim.
 *
 * The claim is automatically released when the hook arguments are updated or
 * when the hook is unmounted.
 *
 * # Offline behavior
 *
 * If Hedwig is unavailable, `claim.acquire` and `claim.release` will emulate
 * the claim logic locally. In this case, the returned owner might be an empty
 * string instead of a valid identifier.
 */
export function useChannelClaim(
    subscription: SubscriptionHandle,
    resource: string,
): [string | null, boolean, ClaimHandle] {
    // Whether the hook owns the claim. If true, the claim will be automatically
    // released when the hook arguments are updated or when the hook is unmounted.
    const owned = useRef<boolean>(false);

    const [owner, setOwner] = useState<[string, boolean] | undefined>(() => {
        const claims = subscription.claims;
        const owner = claims.claims[resource];
        owned.current = owner !== undefined && claims.own.includes(resource);
        return owner === undefined ? undefined : [owner, owned.current];
    });

    useAbortableEffect(
        (signal) => {
            subscription.addEventListener<Claims>(ServerEvent.ChannelClaims, ({ detail }) => {
                const owner = detail.claims[resource];
                owned.current = owner !== undefined && detail.own.includes(resource);
                setOwner(owner === undefined ? undefined : [owner, owned.current]);
            }, { signal });
        },
        [subscription, resource]
    );

    // On unmount or when the resource changes, release the claim.
    useEffect(() => {
        return () => {
            owned.current && subscription.claimRelease(resource);
            owned.current = false;
        };
    }, [subscription, resource]);

    const handle = useMemo<ClaimHandle>(() => {
        return {
            acquire: (force?: boolean) => subscription.claimAcquire(resource, force ?? false),
            release: () => subscription.claimRelease(resource),
        };
    }, [subscription, resource]);

    return owner === undefined ? [null, false, handle] : [owner[0], owner[1], handle];
}

/**
 * ClaimHandle allows to acquire and release the claim for the resource.
 */
type ClaimHandle = {
    /**
     * Acquires an exclusive claim for the resource. If `force` is true, the
     * claim succeeds even if the resource is already claimed.
     *
     * Returns whether the claim was acquired.
     */
    acquire: (force?: boolean) => Promise<boolean>;

    /**
     * Releases your own claim for the resource. If the resource is claimed by
     * someone else, this does nothing.
     *
     * Returns whether the claim was actually released.
     */
    release: () => Promise<boolean>;
}
