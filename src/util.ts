export function abortPromise(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.reject(signal.reason);
    }
    return new Promise((_, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
        } else {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }
    });
}

export function sleep(delay: number, signal?: AbortSignal): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timeout = setTimeout(resolve, delay);

    return !signal ? promise : Promise.race([
        abortPromise(signal).finally(() => clearTimeout(timeout)),
        promise,
    ]);
}
