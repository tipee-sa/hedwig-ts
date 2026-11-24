import React, { useEffect } from "react";

/** @internal */
export function useAbortableEffect(
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
