import React, { useContext, useEffect, useRef, useState } from "react";
import { Context } from "../context";
import { Authorizer } from "../../core/service/subscription";
import { SubscriptionHandle } from "../../core/service/subscriptionHandle";

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
