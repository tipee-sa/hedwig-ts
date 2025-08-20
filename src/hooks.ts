import React, { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Context } from "./context";
import { Authorizer, SubscriptionHandle } from "./service";

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
 * useChannelMessages sets up a listener for messages on the given subscription.
 *
 * It will call the handler with messages received from the channel. The type
 * `M` will be used as the type of the message payload for convenience but
 * can't be verified and might not match the actual message type.
 *
 * If the channel is unavailable, this hook does nothing.
 */
export function useChannelMessages<M>(
    subscription: SubscriptionHandle,
    handler: (message: M) => void,
    deps: React.DependencyList,
) {
    useAbortableEffect(
        (signal) => subscription.addEventListener<M>('channel:message', ({ detail }) => handler(detail), { signal }),
        [subscription, ...deps], // Not including `handler`, as its dependencies should already be in `deps`
    );
}

/**
 * useChannelState is a shared variant of a standard useState hook.
 *
 * Whenever the channel state is updated, every clients connected to the channel
 * will receive the new state. Like the standard hook, the new value can be
 * either:
 *   - a value, in this case it is simply sent to the server and will override
 *     whatever previous value might exist, without any considerations for
 *     possible race conditions; or
 *   - a function that takes the previous value and returns the new value, in
 *     this case concurrent updates are detected and the state update is retried
 *     until it succeeds.
 *
 * If the channel is unavailable, this hook behaves like a standard useState.
 */
export function useChannelState<S>(
    subscription: SubscriptionHandle,
    initialState: (S extends Function ? never : S) | (() => S),
): [S, SetState<S>] {
    // Start with either the value already known by the subscription, or the given initial value.
    const [state, setInner] = useState<S>(() => {
        //return subscription.state.orElse(
        return (typeof initialState === 'function'
            ? (initialState as () => S) // Assume any function is a factory function
            : () => initialState)();
        // );
    });

    // Ensure that `setState` is stable if nothing else changes.
    const setState = useCallback<SetState<S>>((value) => { /* subscription.setState(value) */ }, [subscription]);
/*
    useAbortableEffect(
        (signal) => {
            // If the channel has a defined state, we use it as the hook state.
            // Otherwise, we update the channel state with whatever value we
            // have in the hook, but taking care to only override an undefined
            // state, as the value might not yet be loaded.
            subscription.state.isSome()
                ? setInner(subscription.state.value)
                : subscription.setState(() => state, true);

            // Then, we keep the hook in-sync with the channel state.
            //
            // Note: that the `channel:state` event is fired even if the socket
            // is unavailable as Hedwig will keep track of state changes and
            // reconcile when the socket is reconnected.
            subscription.addEventListener('channel:state', ({ detail }) => setInner(detail), { signal });
        },
        [subscription]
    );
*/
    return [state, setState];
}

type SetState<S> = (value: (S extends Function ? never : S) | ((prev: S | undefined) => S)) => void;

/**
 * useChannelPresence returns the presence set for channel bound to the given
 * subscription.
 */
export function useChannelPresence<P extends string>(
    subscription: SubscriptionHandle
): P[] {
    /*const [presence, setPresence] = useState<P[]>((() => subscription.presence as P[]));

    useAbortableEffect(
        (signal) => {
            // Update the presence state when the channel presence changes.
            subscription.addEventListener('channel:presence', ({ detail }) => setPresence(detail as P[]), { signal });
        },
        [subscription]
    );

    return presence;*/
    return [];
}
