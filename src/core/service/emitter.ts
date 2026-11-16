export abstract class EventEmitter {
    #eventTarget: EventTarget = new EventTarget();

    dispatchEvent(event: string, detail: unknown): boolean {
        return this.#eventTarget.dispatchEvent(new CustomEvent(event, { detail }));
    }

    addEventListener(type: string, callback: (e: CustomEvent) => void, options?: AddEventListenerOptions): void {
        this.#eventTarget.addEventListener(type, callback as EventListener, options);
    }

    /**
     * Returns a promise resolved on the next `type` event, or rejected with
     * the signal's reason if `signal` aborts first. Either way, both listeners
     * are removed, so a long-lived signal can be reused across many waits.
     */
    protected eventPromise(type: string, signal: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                return reject(signal.reason);
            }
            const onAbort = () => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            this.addEventListener(type, () => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, { once: true, signal });
        });
    }
}
