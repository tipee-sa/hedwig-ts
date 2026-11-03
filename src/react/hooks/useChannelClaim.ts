import { useEffect, useMemo, useRef, useState } from "react";
import { SubscriptionHandle } from "../../core/service/subscriptionHandle";
import { Claims, ServerEvent } from "../../core/proto";
import { useAbortableEffect } from "./useAbortableEffect";

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
            if (subscription.canceled) return;
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
