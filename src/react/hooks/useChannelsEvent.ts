import React from "react";
import { SubscriptionHandle } from "../../core/service/subscriptionHandle";
import { ServerEvent } from "../../core/proto";
import { useAbortableEffect } from "./useAbortableEffect";

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
