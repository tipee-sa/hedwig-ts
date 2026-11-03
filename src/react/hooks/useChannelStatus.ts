import { useState } from "react";
import { SubscriptionHandle } from "../../core/service/subscriptionHandle";
import { ServerEvent } from "../../core/proto";
import { useAbortableEffect } from "./useAbortableEffect";

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
            if (subscription.canceled) return;
            setState(subscription.isConnected);
            subscription.addEventListener(ServerEvent.ChannelUp, () => setState(subscription.isConnected), { signal });
            subscription.addEventListener(ServerEvent.ChannelDown, () => setState(subscription.isConnected), { signal });
        },
        [subscription]
    );

    return state;
}
