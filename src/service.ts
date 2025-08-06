import { HedwigToken } from './token';
import { ClientMessageMap, ClientOp, ErrorCode, ServerMessage, ServerOp, ServerResultFor, ServerResultType } from './proto';
import { Option, Result, sleep } from './util';
import { ConsoleLogger, Level, Logger } from './logger';
import { Operation, StateBuffer, StateSetter, StateSource } from './state';

/** A function that produce a token for a subscription */
export type Authorizer = (s: AbortSignal) => string | Promise<string>;

/** The value that is thrown whenever attempting to use a disconnected socket or channel */
const ERR_DISCONNECTED = Symbol('ERR_DISCONNECTED');

/**
 * A ServerError wraps the error code, message, and any additional detail
 * returned by the server when an operation fails.
 */
export class ServerError<C extends ErrorCode, T> extends Error {
    constructor(readonly code: C, readonly message: string, readonly detail: T) {
        super(`[E${code}] ${message}`);
        this.name = this.constructor.name;
    }
}

/**
 * An abstract, type-safe, event emitter. `EventMap` must be a mapping of
 * event names to their payload types.
 */
abstract class EventEmitter<EventMap> {
    /**
     * The underlying event target used to manage listeners and dispatch events.
     * Its methods are wrapped by the `EventEmitter` to provide a type-safe API.
     */
    #eventTarget: EventTarget = new EventTarget();

    /** Adds an event listener to this emitter. */
    addEventListener<K extends keyof EventMap & string>(
        type: K,
        callback: (ev: CustomEvent<EventMap[K]>) => void,
        options?: AddEventListenerOptions
    ): void {
        this.#eventTarget.addEventListener(type, callback as EventListener, options);
    }

    /** Removes an event listener from this emitter. */
    removeEventListener<K extends keyof EventMap & string>(
        type: K,
        callback: (ev: CustomEvent<EventMap[K]>) => void,
        options?: EventListenerOptions
    ): void {
        this.#eventTarget.removeEventListener(type, callback as EventListener, options);
    }

    /** Dispatches an event from this emitter. */
    dispatchEvent<K extends keyof EventMap & string>(
        type: K,
        detail: EventMap[K],
        cancelable: boolean = false
    ): boolean {
        return this.#eventTarget.dispatchEvent(new CustomEvent(type, { detail, cancelable }));
    }
}

/**
 * The Service is the entry-point for Hedwig interactions. It is responsible to
 * manage the underlying WebSocket connection, keep track of active channels and
 * subscriptions, and share resources if multiple subscriptions are using the
 * same channel.
 */
export class Service extends EventEmitter<{
    'socket:up': Map<string, HedwigToken>;
    'socket:down': CloseEvent;
}> {
    /** The logger instance */
    readonly #logger: Logger;

    /** Map (by-name) of every active channel */
    readonly #channels = new Map<string, Channel>();

    /** Set of active subscriptions, this might include initializing subscriptions */
    readonly #subscriptions = new Set<Subscription>();

    /** The map of the current channel for every subscription */
    readonly #currentChannel = new Map<Subscription, Channel>();

    /** The map of pending requests, with their resolvers. */
    readonly #requests = new Map<number, PromiseWithResolvers<Result<any, ServerError<any, any>>>>();

    /** The underlying WebSocket used to communicate with the backend */
    #socket: WebSocket | null = null;

    /** The OperationId counter */
    #nextOID = 0;

    /** The number of reconnection attempts, used for exponential backoff */
    #reconnectAttempts = 0;

    /** Timer for scheduling the next reconnection attempt */
    #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    /** Timer for scheduling a graceful disconnect when no subscriptions are active */
    #gracefulDisconnectTimer: ReturnType<typeof setTimeout> | null = null;

    /** Indicates whether the service has been terminated */
    #terminated: boolean = false;

    constructor(public url: string, verbosity: Level = Level.Essential) {
        super();
        this.#logger = new ConsoleLogger(verbosity).withPrefix('Hedwig');
    }

    /** Whether the service is connected to the backend. */
    get isConnected(): boolean {
        return this.#socket !== null && this.#socket.readyState === WebSocket.OPEN;
    }

    /**
     * Returns a promise that will be resolved when the service gets connected.
     *
     * If `signal` is aborted before the promise resolves, the promise will
     * never be resolved, but the underlying event listener will be cancelled.
     */
    upPromise(signal: AbortSignal): Promise<void> {
        if (this.isConnected) {
            return Promise.resolve();
        } else {
            return new Promise(resolve => {
                this.addEventListener('socket:up', () => resolve(), { once: true, signal });
            });
        }
    }

    /**
     * Returns an `AbortSignal` that will be aborted when the service gets
     * disconnected.
     *
     * If `signal` is aborted before the service gets disconnected, the signal
     * signal will never be aborted, but the underlying event listener will be
     * cancelled.
     */
    downSignal(signal: AbortSignal): AbortSignal {
        if (!this.isConnected) {
            return AbortSignal.abort(ERR_DISCONNECTED);
        } else {
            const controller = new AbortController();
            this.addEventListener('socket:down', () => controller.abort(), { once: true, signal });
            return controller.signal;
        }
    }

    /**
     * Creates a new subscription using the provided authorizer function.
     *
     * While multiple subscriptions to the same channel are correctly handled,
     * the authorizer function is still called for each subscription to account
     * for possible channel change from the backend. Known multiple uses of the
     * same channel should instead share a single subscription.
     *
     * @typeParam M - The type of the message payload.
     * @typeParam S - The type of the state payload.
     */
    subscribe<M, S>(signal: AbortSignal, authorizer: Authorizer): SubscriptionHandle<M, S> {
        if (this.#terminated) {
            throw new Error('Service has been terminated');
        }

        // If a graceful disconnect was scheduled, cancel it
        if (this.#gracefulDisconnectTimer !== null) {
            clearTimeout(this.#gracefulDisconnectTimer);
            this.#gracefulDisconnectTimer = null;
        }

        const subscription = new Subscription<M, S>(this, signal, authorizer);
        this.#subscriptions.add(subscription);
        this.#connect();

        return new SubscriptionHandle(subscription);
    }

    /**
     * Creates a sub-logger with the given prefix.
     *
     * @internal
     */
    makeLogger(prefix: string): Logger {
        return this.#logger.withPrefix(prefix);
    }

    /**
     * Unified method to update or remove a subscription based on a new token
     * state. Accepts a HedwigToken instance (if updating/joining) or null
     * (if cancelling). This method is called internally by the `Subscription`.
     *
     * @internal
     */
    async updateSubscription(sub: Subscription, token: HedwigToken | null) {
        const oldChannel = this.#currentChannel.get(sub);

        // Handle leaving the previous channel
        if (oldChannel && (token === null || oldChannel.name !== token.channel)) {
            oldChannel.removeSubscription(sub);

            if (!oldChannel.hasSubscriptions()) {
                this.#logger.info('No more subscriptions for channel %s', oldChannel.name);
                oldChannel.close();
                this.#channels.delete(oldChannel.name);
                if (this.isConnected) {
                    this.send({ [ClientOp.Leave]: [oldChannel.name] }).catch((err) => {
                        // Ignore disconnect errors when leaving.
                        if (err !== ERR_DISCONNECTED) {
                            throw err;
                        }
                    });
                }
            }

            this.#currentChannel.delete(sub);
        }

        // Handle joining a new channel or renewing an existing subscription
        if (token !== null) {
            const name = token.channel;

            // Open a new channel if it doesn't exist
            if (!this.#channels.has(name)) {
                this.#logger.info('Joining channel %s', name);
                this.#channels.set(name, new Channel(name, this));
            }

            const channel = this.#channels.get(name)!;

            // If this subscription is not already in the channel, add it
            if (!oldChannel || oldChannel.name !== name) {
                this.#currentChannel.set(sub, channel);
                channel.addSubscription(sub);
            }

            // Send the token to either join or renew the subscription
            if (this.isConnected) {
                try {
                    await this.send({ [ClientOp.Join]: [token.raw] });
                    channel.isConnected = true;
                } catch (err) {
                    if (err !== ERR_DISCONNECTED) {
                        throw err;
                    }
                }
            }
        }
    }

    /**
     * Removes a subscription from the service.
     *
     * @internal
     */
    removeSubscription(sub: Subscription): void {
        this.updateSubscription(sub, null).catch(() => { /* Ignore errors, the subscription is being removed */ });
        this.#subscriptions.delete(sub);

        if (this.#subscriptions.size === 0 && this.#socket) {
            this.#logger.debug('No active subscriptions, scheduling graceful disconnect');
            // If there are no more subscriptions, schedule a graceful disconnect
            if (this.#gracefulDisconnectTimer === null) {
                this.#gracefulDisconnectTimer = setTimeout(() => {
                    this.#logger.debug('Gracefully disconnecting WebSocket due to inactivity');
                    this.#disconnect();
                    this.#gracefulDisconnectTimer = null;
                }, 5000); // 5 seconds delay
            }
        }
    }

    /**
     * Terminates the service, closing the WebSocket connection and channels.
     */
    terminate() {
        this.#logger.info('Terminating service');
        this.#terminated = true;
        this.#disconnect();
        if (this.#reconnectTimer !== null) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
    }

    /**
     * Attempts to connect to the WebSocket server.
     */
    #connect() {
        if (this.#socket) {
            return;
        }

        this.#logger.debug('Attempting to connect to WebSocket:', this.url);

        this.#socket = new WebSocket(this.url, ['hedwig']);
        this.#socket.onopen = this.#onOpen;
        this.#socket.onmessage = this.#onMessage;
        this.#socket.onerror = this.#onError;
        this.#socket.onclose = this.#onClose;
    }

    /**
     * Schedules the next reconnection attempt with exponential backoff.
     */
    #scheduleReconnect() {
        if (this.#terminated || this.#reconnectTimer !== null) {
            return;
        }

        const delay = 500 * (Math.random() + 2 ** Math.min(5, this.#reconnectAttempts++)); // Exponential backoff, max ~15s
        this.#logger.debug('Scheduling reconnect attempt %d in %d ms', this.#reconnectAttempts, delay);

        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null; // Allow new attempt
            this.#connect();
        }, delay);
    }

    /**
     * Sends a message to the server and returns a promise that resolves to the
     * server's response.
     */
    send<T, O extends ClientOp>(message: ClientMessageMap[O]): Promise<ServerResultFor<O, T>> {
        if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(ERR_DISCONNECTED);
        }

        const oid = ++this.#nextOID;
        const serialized = JSON.stringify([oid, message]);

        this.#socket.send(serialized);

        const deferred = Promise.withResolvers<ServerResultFor<O, T>>();
        this.#requests.set(oid, deferred);
        return deferred.promise;
    }

    /**
     * Disconnects the WebSocket connection if it is open.
     */
    #disconnect() {
        if (this.#socket) {
            this.#socket.close();
            this.#socket = null;
        }
    }

    readonly #onOpen = async () => {
        this.#logger.debug('WebSocket connected successfully.');
        this.#reconnectAttempts = 0; // Reset reconnection attempts on successful connection

        const channelToRejoin = new Map<string, HedwigToken>();
        this.dispatchEvent('socket:up', channelToRejoin);
        // Subscriptions will populate the channelToRejoin map with tokens.

        const tokens = Array.from(channelToRejoin.values()).map(t => t.raw);
        if (tokens.length > 0) {
            // This must be the first message sent once the connection is ready
            // to match the bootstrap protocol.
            try {
                await this.send({ [ClientOp.Join]: tokens });
                for (const name of channelToRejoin.keys()) {
                    const channel = this.#channels.get(name);
                    if (channel) {
                        channel.isConnected = true;
                    }
                }
            } catch (err) {
                if (err !== ERR_DISCONNECTED) {
                    throw err;
                }
            }
        }
    }

    readonly #onMessage = (e: MessageEvent) => {
        const message = JSON.parse(e.data) as ServerMessage;
        switch (true) {
            case ServerOp.Message in message: {
                const [channelName, payload] = message[ServerOp.Message];
                const channel = this.#channels.get(channelName);
                if (channel) {
                    channel.dispatchMessage(payload);
                }
                return;
            }

            case ServerOp.State in message: {
                const [channelName, [state, revision]] = message[ServerOp.State];
                const channel = this.#channels.get(channelName);
                if (channel) {
                    channel.dispatchState(state, revision);
                }
                return;
            }

            case ServerOp.Presence in message: {
                const [channelName, presence] = message[ServerOp.Presence];
                const channel = this.#channels.get(channelName);
                if (channel) {
                    channel.dispatchPresence(presence);
                }
                return;
            }

            case ServerOp.Response in message: {
                const [oid, result] = message[ServerOp.Response];
                const resolver = this.#requests.get(oid);
                if (resolver) {
                    this.#requests.delete(oid);
                    if (!result) {
                        resolver.resolve(Result.ok(undefined)); // No result, resolve with undefined
                    } else if (ServerResultType.Success in result) {
                        resolver.resolve(Result.ok(result[ServerResultType.Success]));
                    } else if (ServerResultType.Error in result) {
                        const [code, message, detail] = result[ServerResultType.Error];
                        resolver.resolve(Result.err(new ServerError(code, message, detail)));
                    } else {
                        this.#logger.error('Invalid server response:', result);
                        resolver.reject(new Error('Invalid server response'));
                    }
                }
                return;
            }

            case ServerOp.ChannelClosed in message: {
                throw new Error('NYI: Channel closed notifications are not yet implemented');
                return;
            }

            default:
                this.#logger.warn('Unhandled message:', message);
        }
    }

    readonly #onError = (e: Event) => {
        this.#logger.error('WebSocket error:', e);
        // Error often precedes close, so reconnection is handled in onclose
    }

    readonly #onClose = (event: CloseEvent) => {
        this.#logger.info('WebSocket closed. Code:', event.code, '; Reason:', event.reason, '; Clean:', event.wasClean);
        this.#socket = null;
        this.dispatchEvent('socket:down', event);

        for (const channel of this.#channels.values()) {
            channel.isConnected = false;
            channel.dispatchPresence([]); // Clear presence on disconnect
        }

        // Cancel all outgoing requests
        for (const resolver of this.#requests.values()) {
            resolver.reject(ERR_DISCONNECTED);
        }
        this.#requests.clear();

        // If there are still subscriptions active, the websocket should not
        // have been closed... Schedule a reconnect attempt.
        if (this.#subscriptions.size > 0) {
            this.#logger.warn('WebSocket closed unexpectedly, attempting to reconnect...');
            this.#scheduleReconnect();
        }
    }
}

/**
 * A Channel is a single Hedwig channel. A single instance is shared by all
 * subscriptions that use the same channel name.
 */
class Channel<M = any, S = any> extends EventEmitter<{
    'channel:up': void;
    'channel:down': void;
}> {
    /** The abort controller used to cancel operations on this channel on close */
    #abort = new AbortController();

    /** Whether the channel is currently connected */
    #isConnected = false;

    /** The set of subscriptions using this channel */
    #subscriptions = new Set<Subscription<M, S>>();

    /** The state buffer for this channel */
    #stateBuffer = new StateBuffer<S>();

    /** The upstream for the state buffer, used to implement the actual state synchronization */
    #stateSource: StateSource<S>;

    /** The presence set for this channel */
    #presence: string[] = [];

    constructor(
        readonly name: string,
        private readonly service: Service,
    ) {
        super();
        this.#stateSource = new ChannelState(this, this.#abort.signal, this.service);
        this.#stateBuffer.upstream = this.#stateSource;
    }

    get isConnected(): boolean {
        return this.#isConnected;
    }

    set isConnected(value: boolean) {
        if (this.#isConnected !== value) {
            this.#isConnected = value;
            if (value) {
                this.dispatchEvent('channel:up', undefined);
            } else {
                this.dispatchEvent('channel:down', undefined);
            }
        }
    }

    /** @see Service.upPromise() */
    upPromise(signal: AbortSignal): Promise<void> {
        if (this.#isConnected) {
            return Promise.resolve();
        } else {
            return new Promise(resolve => {
                this.addEventListener('channel:up', () => resolve(), { once: true, signal });
            });
        }
    }

    /** @see Service.downSignal() */
    downSignal(signal: AbortSignal): AbortSignal {
        if (!this.#isConnected) {
            return AbortSignal.abort(ERR_DISCONNECTED);
        } else {
            const controller = new AbortController();
            this.addEventListener('channel:down', () => controller.abort(), { once: true, signal });
            return controller.signal;
        }
    }

    /** Adds a subscription to this channel. */
    addSubscription(sub: Subscription<M, S>) {
        this.#subscriptions.add(sub);
        sub.stateUpstream = this.#stateBuffer;
        sub.dispatchEvent('channel:presence', this.#presence);
    }

    /** Removes a subscription from this channel. */
    removeSubscription(sub: Subscription<M, S>): boolean {
        return this.#subscriptions.delete(sub);
    }

    /** Checks if there are any subscriptions for this channel. */
    hasSubscriptions(): boolean {
        return this.#subscriptions.size > 0;
    }

    /** Dispatches a message from the server. */
    dispatchMessage(message: M): void {
        for (const sub of this.#subscriptions) {
            sub.dispatchEvent('channel:message', message);
        }
    }

    /** Dispatches a state update from the server. */
    dispatchState(state: unknown, revision: string) {
        this.#stateSource.sync(Option.some(state as S), revision);
    }

    /** Dispatches a presence update from the server. */
    dispatchPresence(presence: string[]): void {
        this.#presence = presence;
        for (const sub of this.#subscriptions) {
            sub.dispatchEvent('channel:presence', presence);
        }
    }

    /** Closes this channel. */
    close() {
        this.#abort.abort();
    }
}

/**
 * A ChannelState is a `StateSource` that implements the actual synchronization
 * logic between the client-side channel state and the server-side state.
 */
class ChannelState<S> extends StateSource<S> {
    constructor(
        private readonly channel: Channel<any, S>,
        private readonly signal: AbortSignal,
        private readonly service: Service,
    ) {
        super();
    }

    protected async processOperations(poll: () => Operation<S> | undefined): Promise<void> {
        for (let op = poll(); op; op = poll()) {
            await this.#sendState(op);
        }
    }

    async #sendState(operation: Operation<S>): Promise<void> {
        const op = { ...operation }; // Clone the operation to avoid modifying the original
        while (!this.signal.aborted) {
            await this.channel.upPromise(this.signal);
            try {
                let res = await this.service.send<S, ClientOp.SetState>({
                    [ClientOp.SetState]: [this.channel.name, op.value, op.revision],
                });
                if (res.isErr()) {
                    const err = res.value;
                    if (err.code === ErrorCode.WrongRevision) {
                        if ('v' in err.detail) {
                            if (op.mode === 'merge' && !op.weak) {
                                op.value = op.fn(err.detail.v);
                                op.revision = err.detail.r;
                                continue;
                            } else {
                                // If the operation was a put or a weak-merge, let's drop the change altogether.
                                return;
                            }
                        } else {
                            // There is no value on the server-side. It usually means that the state was reset.
                            // We retry using the correct revision for any type of operation.
                            op.revision = err.detail.r;
                            continue;
                        }
                    }
                    else {
                        // Some other error occurred, we should not retry.
                        throw err;
                    }
                }
                return; // Done
            }
            catch (err) {
                if (err === ERR_DISCONNECTED) {
                    continue;
                }
                console.error('Failed to send state update:', err);
                return;
            }
        }
    }
}

/** Events emitted by a `Subscription` */
type SubscriptionEventMap<M, S> = {
    'channel:message': M;
    'channel:state': S;
    'channel:presence': string[];
};

/**
 * A Subscription is a single lease on a channel. It maps 1:1 to a `useChannel`
 * hook from the public API, and is responsible for managing the lifetime of
 * the subscription, including renewing the token and handling reconnection.
 */
class Subscription<M = any, S = any> extends EventEmitter<SubscriptionEventMap<M, S>> {
    static #nextSubscriptionId = 0;

    /** The unique ID of this subscription */
    readonly #subscriptionId: number = ++Subscription.#nextSubscriptionId;

    /** The logger instance for this subscription */
    readonly #logger: Logger;

    /** The state buffer for this subscription */
    readonly #stateBuffer = new StateBuffer<S>();

    constructor(
        readonly service: Service,
        readonly signal: AbortSignal,
        readonly authorizer: Authorizer,
    ) {
        super();
        this.#logger = service.makeLogger(`S:${this.#subscriptionId}`);
        this.#stateBuffer.subscribe((state) => state.isSome() && this.dispatchEvent('channel:state', state.value));
        this.#run(); // Async
    }

    /** Updates the upstream for the state buffer for this subscription. */
    set stateUpstream(upstream: StateBuffer<S> | undefined) {
        this.#stateBuffer.upstream = upstream;
    }

    /** The main lifecycle of this subscription, will run until terminated. */
    async #run(): Promise<void> {
        try {
            this.#logger.debug('Subscription created');

            // Wait until the service is connected before proceeding.
            await this.service.upPromise(this.signal);

            // Retrieve the initial token for this subscription.
            let token = await this.#fetchToken(undefined, 10);
            this.service.updateSubscription(this, token);

            // From now on, every time the socket is established, we will
            // contribute our token to the set of recovered tokens, it is
            // still valid. If it is not valid anymore,, we'll record this
            // as this means the we need to re-fetch a token ASAP.
            let tokenWasForgotten = false;
            this.service.addEventListener('socket:up', ({ detail: tokens }) => {
                if (token.isValid) {
                    if (!tokens.has(token.channel)) {
                        tokens.set(token.channel, token);
                    }
                } else {
                    tokenWasForgotten = true;
                }
            }, { signal: this.signal });

            // Keep the subscription alive until canceled.
            // The outer loop will iterate each time the service experience a
            // disconnect-reconnect cycle.
            while (!this.signal.aborted) {
                await this.service.upPromise(this.signal);
                const disconnected = this.service.downSignal(this.signal);

                // The inner loop will run as long as the service stays
                // connected. It will refresh the token whenever it is about
                // to expire.
                while (!disconnected.aborted) {
                    const tokenExpiration = tokenWasForgotten ? null : AbortSignal.timeout(token.subscriptionExpiration - Date.now());
                    const signal = AbortSignal.any([
                        this.signal,
                        disconnected,
                        ...(tokenExpiration ? [tokenExpiration] : []),
                    ]);

                    try {
                        if (!tokenWasForgotten) {
                            // Renew at 90% of the lifetime, but at least 5 seconds before expiration.
                            const renewalAt = token.subscriptionExpiration - Math.max(token.subscriptionLifetime * 0.1, 5000);
                            const delay = Math.max(0, renewalAt - Date.now());
                            if (delay > 0) {
                                await sleep(delay, signal);
                            }
                        }

                        this.#logger.debug('Renewing subscription token');
                        token = await this.#fetchToken(signal);
                        tokenWasForgotten = false; // Reset the flag after a successful fetch
                        this.service.updateSubscription(this, token);
                    }
                    catch (err) {
                        if (tokenExpiration?.aborted) {
                            this.#logger.warn('Token renewal timed out, subscription will be canceled');
                            this.service.updateSubscription(this, null);
                        } else if (disconnected.aborted) {
                            break; // Exit the inner loop, wait for reconnection
                        } else {
                            throw err;
                        }
                    }
                }
            }
        }
        catch (err) {
            if (!this.signal.aborted) {
                this.#logger.error('An unexpected error caused the subscription to fail:', err);
            }
        }
        finally {
            // Unregister the subscription from the service, at this point it
            // is effectively dead.
            this.service.removeSubscription(this);
            this.#logger.debug('Subscription canceled');
        }
    }

    /** Fetches the authorization token using the channel `authorizer`. */
    async #fetchToken(signal?: AbortSignal, maxAttempts: number = Number.MAX_SAFE_INTEGER): Promise<HedwigToken> {
        signal = signal ? AbortSignal.any([this.signal, signal]) : this.signal;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            this.signal.throwIfAborted();

            try {
                const rawToken = await this.authorizer(AbortSignal.any([signal, AbortSignal.timeout(5000)]));
                const token = new HedwigToken(rawToken);
                this.#logger.prefix = `S:${this.#subscriptionId}:${token.channel}`;
                return token;
            }
            catch (err: any) {
                if (signal.aborted) throw err;
                this.#logger.error('Authorization failed:', err);
            }

            const delay = 500 * (Math.random() + 2 ** Math.min(6, attempt)); // Exponential backoff, max ~30s
            this.#logger.debug('Retrying authorization in %d ms', delay);
            await sleep(delay, signal);
        }
        throw new Error('Authorization failed after too many attempts');
    }

    // State proxying
    getState(): Option<S> { return this.#stateBuffer.getState(); }
    setState(setter: StateSetter<S>, weak: boolean): void { this.#stateBuffer.setState(setter, weak); }

    getPresence(): string[] {
        // Presence is not implemented in this version, return an empty array
        return [];
    }
}

/**
 * A SubscriptionHandle is the public API for a subscription.
 * It is returned by the [`Service.subscribe`] method.
 *
 * @typeParam M - The type of the message payload.
 * @typeParam S - The type of the state payload.
 */
export class SubscriptionHandle<M, S> {
    /** The internal subscription state */
    #subscription: Subscription<M, S>;

    /** @internal */
    constructor(subscription: Subscription<M, S>) {
        this.#subscription = subscription;
    }

    /** Returns whether the subscription is canceled. */
    get canceled(): boolean {
        return this.#subscription.signal.aborted;
    }

    /** Adds an event listener to the subscription. */
    addEventListener<K extends keyof SubscriptionEventMap<M, S>>(
        type: K,
        callback: (ev: CustomEvent<SubscriptionEventMap<M, S>[K]>) => void,
        options?: AddEventListenerOptions
    ): void {
        if (this.canceled) {
            throw new Error('Cannot add event listener to a canceled subscription');
        }
        this.#subscription.addEventListener(type, callback as EventListener, options);
    }

    /** Removes an event listener from the subscription. */
    removeEventListener<K extends keyof SubscriptionEventMap<M, S>>(
        type: K,
        callback: (ev: CustomEvent<SubscriptionEventMap<M, S>[K]>) => void,
        options?: EventListenerOptions
    ): void {
        this.#subscription.removeEventListener(type, callback as EventListener, options);
    }

    /** Gets the current state of the channel. */
    get state(): Option<S> {
        return this.#subscription.getState();
    }

    /** Updates the state of the channel. */
    setState(setter: StateSetter<S>, weak: boolean = false): void {
        this.#subscription.setState(setter, weak);
    }

    get presence(): string[] {
        return this.#subscription.getPresence();
    }
}
