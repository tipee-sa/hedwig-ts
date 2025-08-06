import { Option } from "./util";

/** The type for the `useChannelState` setter */
export type StateSetter<S> = (S extends Function ? never : S) | ((prev: S | undefined) => S);

/**
 * Revisions from the server are given as string as the actual u64 value and
 * might overflow the safe range on JS numbers
 */
type Revision = string;

/**
 * Checks if the given value is a state setter function or a direct value.
 */
export function isStateMapper<S>(value: StateSetter<S>): value is (prev: S | undefined) => S {
    return typeof value === 'function';
}

/**
 * The various kinds of state update operations.
 */
export type Operation<S> =
    | { mode: 'put', value: S, revision: Revision }
    | { mode: 'merge', value: S, revision: Revision, fn: (state: S | undefined) => S, weak: boolean }
    ;

/**
 * A Downstream is a component that can produce state operations to be applied
 * to an upstream source of state.
 *
 * Its `poll()` method will be called by the source in response to a `notify()`
 * call, if it is ready to process state updates.
 */
export interface Downstream<S> {
    /**
     * Requests one buffered operation from the buffer. If there are none,
     * returns `undefined`. The returned operation must be removed from the
     * buffer.
     */
    poll(): Operation<S> | undefined;
}

/**
 * An Upstream is an upstream source of state. Downstream components can
 * subscribe to changes and notify the source when they have operations ready
 * to be applied to the state.
 */
export interface Upstream<S> {
    /**
     * Adds a new synchronization listener to the source.
     * The handler will be called immediately after registration.
     */
    subscribe(handler: StateSubscriber<S>): UpstreamNotifier<S>;
}

/**
 * A StateSubscriber is a function that will be called by an `Upstream` whenever
 * the state changes. It receives the current state and the revision of the
 * state as parameters.
 */
export type StateSubscriber<S> = (state: Option<S>, revision: Revision) => void;

/**
 * An UpstreamNotifier is returned whenever subscribing to an `Upstream`.
 *
 * It allows downstream components to notify the upstream source of state
 * that they have operations ready to be applied, and to unsubscribe from the
 * upstream source when they are no longer interested in receiving updates.
 */
export interface UpstreamNotifier<S> {
    /**
     * Notifies the upstream source that the given downstream buffer has
     * operations ready to be processed.
     */
    notify(buf: Downstream<S>): void;

    /**
     * Unsubscribes the downstream from the upstream source.
     *
     * After this call, the downstream will no longer receive updates from the
     * upstream source and will not be able to notify it of any operations.
     */
    unsubscribe(): void;
}

/**
 * A ReadySet is a set of downstream components that have operations ready to
 * be processed by an upstream source.
 *
 * Since it implements `Downstream` itself, a ReadySet allows to combine
 * multiple `Downstream` into a single one.
 */
export class ReadySet<S> implements Downstream<S> {
    #ready = new Set<Downstream<S>>();

    get size(): number {
        return this.#ready.size;
    }

    add(down: Downstream<S>): void {
        this.#ready.add(down);
    }

    delete(down: Downstream<S>): void {
        this.#ready.delete(down);
    }

    clear(): void {
        this.#ready.clear();
    }

    /**
     * Polls all ready downstreams for operations and returns the first one
     * that has operations. If there are none, returns `undefined`.
     */
    poll(): Operation<S> | undefined {
        for (const down of this.#ready) {
            const op = down.poll();
            if (op) {
                return op;
            } else {
                this.#ready.delete(down);
            }
        }
    }
}

/**
 * A StateSourceDownstream is the concrete implementation of `UpstreamNotifier`
 * that is used by `StateSource` when subscribing to it.
 */
export class StateSourceDownstream<S> implements UpstreamNotifier<S> {
    #cancelled = false;
    readonly #ready = new ReadySet<S>();

    constructor(
        readonly handler: StateSubscriber<S>,
        readonly onNotify: (down: StateSourceDownstream<S>) => void,
        readonly onUnsubscribe: () => void,
    ) { }

    notify(buf: Downstream<S>): void {
        if (this.#cancelled) return;
        this.#ready.add(buf);
        this.onNotify(this);
    }

    unsubscribe(): void {
        this.#cancelled = true;
        this.#ready.clear();
        this.onUnsubscribe();
    }

    poll(): Operation<S> | undefined {
        if (this.#cancelled) return undefined;
        return this.#ready.poll();
    }
}

/**
 * A StateSource is an abstract class that implements the `Upstream` interface
 * and provides the basis of state and subscribers management.
 */
export abstract class StateSource<S> implements Upstream<S> {
    private readonly downstreams = new Set<StateSourceDownstream<S>>();
    private readonly ready = new ReadySet<S>();

    protected state: Option<S> = Option.none();
    protected revision: Revision = '0';

    subscribe(handler: StateSubscriber<S>): UpstreamNotifier<S> {
        const downstream = new StateSourceDownstream<S>(
            handler,
            /* onNotify */(down) => {
                this.ready.add(down);
                this.doProcessChanges();
            },
            /* onUnsubscribe */() => {
                this.downstreams.delete(downstream);
                this.ready.delete(downstream);
            },
        );

        // Notify the downstream immediately if the state is available.
        if (this.state.isSome()) {
            handler(this.state, this.revision);
        }

        this.downstreams.add(downstream);
        return downstream;
    }

    private isProcessingOperations = false;
    private async doProcessChanges(): Promise<void> {
        try {
            if (this.isProcessingOperations) {
                return; // Already processing operations, do nothing
            }

            this.isProcessingOperations = true;
            await this.processOperations(() => {
                return this.ready.poll();
            });

            // Check that the changes were indeed fully processed by the
            // implementation. If this is not the case, we risk delaying
            // operations until another change is made as no more
            // notifications will be received in the meantime.
            if (this.ready.size > 0) {
                throw new Error("Changes were not fully processed, there are still buffered operations.");
            }
        } finally {
            this.isProcessingOperations = false;
        }
    }

    protected abstract processOperations(poll: () => Operation<S> | undefined): Promise<void>;

    protected notifyDownstream(): void {
        for (const down of this.downstreams) {
            down.handler(this.state, this.revision);
        }
    }

    sync(state: Option<S>, revision: Revision): void {
        if (
            !isEqual(this.state, state)
            || this.revision !== revision
        ) {
            this.state = state;
            this.revision = revision;
            this.notifyDownstream();
        }
    };
}

/**
 * A StateBuffer is a middleware that implements a layer of buffering over a
 * state source. It allows to continue operations on the state even if the
 * upstream state is not available.
 *
 * It is both an `Upstream` and a `Downstream`, allowing it to be chained into
 * multiple layers of state sources and buffers.
 */
export class StateBuffer<S> extends StateSource<S> implements Upstream<S>, Downstream<S> {
    #upstream: UpstreamNotifier<S> | undefined;
    #changes: Operation<S>[] = [];

    constructor(upstream?: Upstream<S>) {
        super();
        this.upstream = upstream;
    }

    set upstream(upstream: Upstream<S> | undefined) {
        this.#upstream?.unsubscribe();
        this.#upstream = upstream?.subscribe((s, r) => this.sync(s, r));
        if (this.#changes.length > 0) {
            // If we have buffered changes, we need to notify the upstream
            // immediately so that it can process them.
            this.notifyUpstream();
        }
    }

    poll(): Operation<S> | undefined {
        return this.#changes.shift();
    }

    protected async processOperations(poll: () => Operation<S> | undefined): Promise<void> {
        let didChanges = false;
        for (let op = poll(); op; op = poll()) {
            didChanges ||= this.#applyOperation(op);
        }
        didChanges && this.notifyUpstream();
    }

    getState(): Option<S> {
        return this.state;
    }

    setState(setter: StateSetter<S>, weak: boolean = false): void {
        const didChange = this.#applyOperation(
            isStateMapper(setter)
                ? { mode: 'merge', value: setter(this.state.value), revision: this.revision, fn: setter, weak }
                : { mode: 'put', value: setter, revision: this.revision }
        )
        if (didChange) {
            this.notifyUpstream();
            this.notifyDownstream();
        }
    }

    #applyOperation(op: Operation<S>): boolean {
        if (op.mode === 'put' && op.revision !== this.revision) {
            return false; // Ignore operations with a different revision
        }

        const newState = Option.some(
            op.mode === 'merge'
                ? (op.revision === this.revision
                    ? op.value
                    : op.fn(this.state.value))
                : op.value
        );
        if (isEqual(newState, this.state)) {
            return false;
        }

        this.state = newState;
        this.saveOperation({ ...op, value: newState.value!, revision: this.revision });
        return true;
    }

    private saveOperation(op: Operation<S>): void {
        // If the operation was a put, we reset the changes to only retain
        // that last operation so that we don't end up replaying merge
        // changes that are no longer relevant.
        if (op.mode === 'put') {
            this.#changes = [op];
        } else {
            this.#changes.push(op);
        }
    }

    private notifyUpstream(): void {
        this.#upstream?.notify(this);
    }
}

/**
 * Checks if two values are equal, taking into account the special case of
 * `Option` values. This is used to avoid useless state updates in the
 * `StateSource` and `StateBuffer` implementations.
 *
 * @internal
 */
function isEqual(a: any, b: any): boolean {
    if (a instanceof Option && b instanceof Option) {
        return a.isSome() === b.isSome() && (!a.isSome() || isEqual(a.value, b.value));
    }

    // As this is meant to avoid useless state updates, using the actual JSON
    // serialization that will be sent to the server seems like a good idea.
    // FIXME: Maybe performance is bad tho...
    return JSON.stringify(a) === JSON.stringify(b);
}
