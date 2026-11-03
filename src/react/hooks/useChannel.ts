import React, { useContext, useEffect, useMemo } from "react";
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
