/**
 * @internal
 */
export class Option<T> {
    #isSome: boolean;

    private constructor(isSome: boolean, readonly value?: T) {
        this.#isSome = isSome;
    }

    static some<T>(value: T): Option<T> {
        return new Option(true, value);
    }

    static none<T>(): Option<T> {
        return new Option(false, undefined!);
    }

    isSome(): this is this & { value: T } {
        return this.#isSome;
    }

    isNone(): this is this & { value: undefined } {
        return !this.#isSome;
    }

    orElse(defaultValue: () => T): T {
        return this.isSome() ? this.value : defaultValue();
    }
}

/**
 * @internal
 */
export class Result<T, E> {
    #isOk: boolean;

    private constructor(isOk: boolean, readonly value: T | E) {
        this.#isOk = isOk;
    }

    static ok<T>(value: T): Result<T, never> {
        return new Result<T, never>(true, value);
    }

    static err<E>(error: E): Result<never, E> {
        return new Result<never, E>(false, error);
    }

    isOk(): this is Result<T, never> {
        return this.#isOk;
    }

    isErr(): this is Result<never, E> {
        return !this.#isOk;
    }
}

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
