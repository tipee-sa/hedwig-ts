import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Context } from "./context";
import { Authorizer, SubscriptionHandle } from "../core/service/service";
import { Claims, ServerEvent } from "../core/proto";

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

    // Building a handle has no side effect, so a render React discards leaves
    // nothing behind. A new handle per channel lets the hooks reading it start over.
    const handle = useMemo(() => new SubscriptionHandle(), [service, ...deps]);

    useEffect(
        () => {
            const ctrl = new AbortController();
            service.subscribe(handle, ctrl.signal, authorizer);
            return () => ctrl.abort();
        },
        [service, handle], // Not including `authorizer`, as its dependencies should already be in `deps`
    );

    return handle;
}

/**
 * useChannels sets up one subscription per key, for a set of channels that
 * changes over time (e.g. one per item on display), where calling
 * `useChannel` in a loop would break the rules of hooks.
 *
 * Each key must stand for a single channel: `authorizerFor(key)` is called
 * when the key is first subscribed, and its later changes are ignored. A key
 * leaving `keys` cancels its subscription.
 *
 * The returned map only holds a key once its subscription is set up, which
 * happens in an effect: it is empty on the first render.
 */
export function useChannels(
    keys: readonly string[],
    authorizerFor: (key: string) => Authorizer,
): ReadonlyMap<string, SubscriptionHandle> {
    const service = useContext(Context);
    if (service === null) {
        throw new Error('useChannels must be used within a HedwigProvider');
    }

    const active = useRef(new Map<string, { ctrl: AbortController; handle: SubscriptionHandle }>());
    const [handles, setHandles] = useState<ReadonlyMap<string, SubscriptionHandle>>(() => new Map());

    // Read at subscription time only, so that a new function every render does not resubscribe
    // Updated in an effect, not during render, so a discarded render cannot leave its function
    // behind. Declared before the subscribing effect, which therefore always sees the latest one.
    const authorizerForRef = useRef(authorizerFor);
    useEffect(() => {
        authorizerForRef.current = authorizerFor;
    });

    // A value dependency: the same set of keys in a new array must not resubscribe
    const keySet = JSON.stringify([...new Set(keys)].sort());

    useEffect(() => {
        const wanted = new Set<string>(JSON.parse(keySet));
        let changed = false;

        for (const [key, { ctrl }] of active.current) {
            if (!wanted.has(key)) {
                ctrl.abort();
                active.current.delete(key);
                changed = true;
            }
        }

        for (const key of wanted) {
            if (!active.current.has(key)) {
                const ctrl = new AbortController();
                const handle = new SubscriptionHandle();
                service.subscribe(handle, ctrl.signal, authorizerForRef.current(key));
                active.current.set(key, { ctrl, handle });
                changed = true;
            }
        }

        if (changed) {
            setHandles(new Map(Array.from(active.current, ([key, { handle }]) => [key, handle])));
        }
    }, [service, keySet]);

    // Kept apart from the effect above, which only cancels the keys leaving the set: this one
    // cancels them all on unmount — StrictMode's simulated one included, after which the effect
    // above finds nothing active and subscribes everything afresh.
    useEffect(() => {
        const subscriptions = active.current;
        return () => {
            for (const { ctrl } of subscriptions.values()) {
                ctrl.abort();
            }
            subscriptions.clear();
        };
    }, [service]);

    return handles;
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
        (signal) => {
            subscription.addEventListener(ServerEvent.ChannelEvent, ({ detail }) => handler(detail), { signal });
        },
        [subscription, ...deps], // Not including `handler`, as its dependencies should already be in `deps`
    );
}

/**
 * useChannelsEvent sets up a listener for events on every subscription of the
 * given map (see `useChannels`). The handler receives the key of the channel
 * the event came from.
 *
 * # Offline behavior
 *
 * When offline, no events are ever received.
 */
export function useChannelsEvent(
    subscriptions: ReadonlyMap<string, SubscriptionHandle>,
    handler: (key: string, event: unknown) => void,
    deps: React.DependencyList,
) {
    useAbortableEffect(
        (signal) => {
            for (const [key, subscription] of subscriptions) {
                subscription.addEventListener(ServerEvent.ChannelEvent, ({ detail }) => handler(key, detail), { signal });
            }
        },
        [subscriptions, ...deps], // Not including `handler`, as its dependencies should already be in `deps`
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
 *
 * The handle gets its subscription in the effect of `useChannel`, which runs
 * after the effects of the components it renders. An acquisition made before,
 * such as in a child's mount effect, resolves to `false` and emulates nothing.
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
            const update = (claims: Claims) => {
                const owner = claims.claims[resource];
                owned.current = owner !== undefined && claims.own.includes(resource);
                setOwner(owner === undefined ? undefined : [owner, owned.current]);
            };
            // The state is only initialized on the first render: the handle or
            // the resource may have changed since.
            update(subscription.claims);
            subscription.addEventListener<Claims>(ServerEvent.ChannelClaims, ({ detail }) => update(detail), { signal });
        },
        [subscription, resource]
    );

    // On unmount or when the resource changes, release the claim.
    useEffect(() => {
        return () => {
            // Nobody is left to handle a failure, such as the socket dropping
            // before the server answers.
            owned.current && subscription.claimRelease(resource).catch(() => {});
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
