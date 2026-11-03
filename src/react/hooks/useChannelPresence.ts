import { useState } from "react";
import { SubscriptionHandle } from "../../core/service/subscriptionHandle";
import { ServerEvent } from "../../core/proto";
import { useAbortableEffect } from "./useAbortableEffect";

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
