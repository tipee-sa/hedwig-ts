/**
 * Settles as `promise` does, unless `signal` aborts first, which rejects with
 * its reason. The abort listener is removed once either happens, so that a
 * long-lived signal does not collect one listener per call.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(signal.reason);
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

export function sleep(delay: number, signal?: AbortSignal): Promise<void> {
    const { promise, resolve } = Promise_withResolvers<void>();
    const timeout = setTimeout(resolve, delay);

    return !signal ? promise : abortable(promise, signal).catch(err => {
        clearTimeout(timeout);
        throw err;
    });
}


export type PromiseWithResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

/**
 * Polyfill implementation of Promise.withResolvers
 */
export function Promise_withResolvers <T>(): PromiseWithResolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
