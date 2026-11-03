import React from "react";
import { SubscriptionHandle } from "../../core/service/subscriptionHandle";
import { ServerEvent } from "../../core/proto";
import { useAbortableEffect } from "./useAbortableEffect";

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
