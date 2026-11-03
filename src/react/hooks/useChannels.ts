import { useContext, useEffect, useRef, useState } from "react";
import { Context } from "../context";
import { Authorizer } from "../../core/service/subscription";
import { SubscriptionHandle } from "../../core/service/subscriptionHandle";

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
                active.current.set(key, { ctrl, handle: service.subscribe(ctrl.signal, authorizerForRef.current(key)) });
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
