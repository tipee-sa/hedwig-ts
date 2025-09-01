import { Features, HedwigToken } from './token';
import { Call, Claims, ClientCalls, ClientMessageMap, ClientOp, ErrorCode, ServerEvent, Feature, ServerMessage, ServerResultFor, ErrorCodeName } from './proto';
import { sleep } from './util';
import { ConsoleLogger, Level, Logger } from './logger';

/** A function that produce a token for a subscription */
export type Authorizer = (s: AbortSignal) => string | Promise<string>;

/** The value that is thrown whenever attempting to use a disconnected socket or channel */
const ERR_DISCONNECTED = Symbol('ERR_DISCONNECTED');

/** The value that is returned when no claims are available */
const NO_CLAIMS: Claims = { claims: {}, own: [] };

/**
 * A ServerError wraps the error code and any additional detail
 * returned by the server when an operation fails.
 */
export class ServerError<C extends ErrorCode, T> extends Error {
    constructor(readonly code: C, readonly detail: T) {
        super(`[E${code}] ${ErrorCodeName.get(code) ?? 'Unknown'}`);
        this.name = this.constructor.name;
    }
}

export abstract class EventEmitter {
    #eventTarget: EventTarget = new EventTarget();

    dispatchEvent(event: string, detail: unknown): boolean {
        return this.#eventTarget.dispatchEvent(new CustomEvent(event, { detail }));
    }

    addEventListener(type: string, callback: (e: CustomEvent) => void, options?: AddEventListenerOptions): void {
        this.#eventTarget.addEventListener(type, callback as EventListener, options);
    }
}

/**
 * The Service is the entry-point for Hedwig interactions. It is responsible to
 * manage the underlying WebSocket connection, keep track of active channels and
 * subscriptions, and share resources if multiple subscriptions are using the
 * same channel.
 */
export class Service extends EventEmitter {
    /** The logger instance */
    readonly #logger: Logger;

    /** Map (by-name) of every active channel */
    readonly #channels = new Map<string, Channel>();

    /** Set of active subscriptions, this might include initializing subscriptions */
    readonly #subscriptions = new Set<Subscription>();

    /** The map of the current channel for every subscription */
    readonly #currentChannel = new Map<Subscription, Channel>();

    /** The map of pending requests, with their resolvers. */
    readonly #requests = new Map<number, PromiseWithResolvers<ServerResultFor<ClientOp, any>>>();

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

    /** Returns the channel for the given subscription. */
    getChannel(sub: Subscription): Channel | undefined {
        return this.#currentChannel.get(sub);
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
                this.addEventListener(ServerEvent.SocketUp, () => resolve(), { once: true, signal });
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
            this.addEventListener(ServerEvent.SocketDown, () => controller.abort(), { once: true, signal });
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
     */
    subscribe(signal: AbortSignal, authorizer: Authorizer): SubscriptionHandle {
        if (this.#terminated) {
            throw new Error('Service has been terminated');
        }

        // If a graceful disconnect was scheduled, cancel it
        if (this.#gracefulDisconnectTimer !== null) {
            clearTimeout(this.#gracefulDisconnectTimer);
            this.#gracefulDisconnectTimer = null;
        }

        const subscription = new Subscription(this, signal, authorizer);
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
                    this.send(ClientOp.Leave, { channel: oldChannel.name }).catch((err) => {
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
            channel.features = token.features;

            // If this subscription is not already in the channel, add it
            if (!oldChannel || oldChannel.name !== name) {
                this.#currentChannel.set(sub, channel);
                channel.addSubscription(sub);
            }

            // Send the token to either join or renew the subscription
            if (this.isConnected) {
                try {
                    await this.send(ClientOp.Join, { token: token.raw });
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
    send<O extends ClientOp, T extends Call>(op: O, data: ClientMessageMap[O]): Promise<ServerResultFor<O, T>> {
        if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(ERR_DISCONNECTED);
        }

        const oid = ++this.#nextOID;
        const serialized = JSON.stringify({ id: oid, op, ...data });

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

        if (channelToRejoin.size > 0) {
            try {
                await Promise.all(Array.from(channelToRejoin.entries()).map(async ([name, token]) => {
                    await this.send(ClientOp.Join, { token: token.raw });
                    const channel = this.#channels.get(name);
                    if (channel) {
                        channel.isConnected = true;
                    }
                }));
            } catch (err) {
                if (err !== ERR_DISCONNECTED) {
                    throw err;
                }
            }
        }
    }

    readonly #onMessage = (e: MessageEvent) => {
        const message = JSON.parse(e.data) as ServerMessage;
        if ('res' in message) {
            const resolver = this.#requests.get(message.res);
            if (resolver) {
                this.#requests.delete(message.res);
                if ('error' in message) {
                    const { error, details } = message;
                    resolver.reject(new ServerError(error, details));
                } else {
                    resolver.resolve(message.data);
                }
            }
        } else if ('event' in message) {
            const channel = this.#channels.get(message.channel!);
            if (channel) {
                channel.handleEvent(message.event, message.data);
            }
        } else {
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
class Channel extends EventEmitter {
    /** The abort controller used to cancel operations on this channel on close */
    #abort = new AbortController();

    /** Whether the channel is currently connected */
    #isConnected = false;

    /** The set of subscriptions using this channel */
    #subscriptions = new Set<Subscription>();

    /** The features of this channel */
    features: Features = {};

    constructor(
        readonly name: string,
        private readonly service: Service,
    ) {
        super();

        // Keep a local copy of the presence if subscriptions are added later.
        this.addEventListener(ServerEvent.ChannelPresence, ({ detail }: CustomEvent<string[]>) => {
            this.#presence = detail;
        });

        // Keep a local copy of the claims if subscriptions are added later.
        this.addEventListener(ServerEvent.ChannelClaims, ({ detail }: CustomEvent<Claims>) => {
            this.#claims = detail;
        });

        // When the channel is disconnected, reset the presence and claims.
        this.addEventListener(ServerEvent.ChannelDown, () => {
            this.handleEvent(ServerEvent.ChannelPresence, []);
            this.handleEvent(ServerEvent.ChannelClaims, NO_CLAIMS);
        });
    }

    /** Whether the channel is currently connected. */
    get isConnected(): boolean {
        return this.#isConnected;
    }

    /** Sets the connected state of this channel. */
    set isConnected(value: boolean) {
        if (this.#isConnected !== value) {
            this.#isConnected = value;
            if (value) {
                this.handleEvent(ServerEvent.ChannelUp, undefined);
            } else {
                this.handleEvent(ServerEvent.ChannelDown, undefined);
            }
        }
    }

    /** @see Service.upPromise() */
    upPromise(signal: AbortSignal): Promise<void> {
        if (this.#isConnected) {
            return Promise.resolve();
        } else {
            return new Promise(resolve => {
                this.addEventListener(ServerEvent.ChannelUp, () => resolve(), { once: true, signal });
            });
        }
    }

    /** @see Service.downSignal() */
    downSignal(signal: AbortSignal): AbortSignal {
        if (!this.#isConnected) {
            return AbortSignal.abort(ERR_DISCONNECTED);
        } else {
            const controller = new AbortController();
            this.addEventListener(ServerEvent.ChannelDown, () => controller.abort(), { once: true, signal });
            return controller.signal;
        }
    }

    /** Adds a subscription to this channel. */
    addSubscription(sub: Subscription) {
        this.#subscriptions.add(sub);
    }

    /** Removes a subscription from this channel. */
    removeSubscription(sub: Subscription): boolean {
        return this.#subscriptions.delete(sub);
    }

    /** Checks if there are any subscriptions for this channel. */
    hasSubscriptions(): boolean {
        return this.#subscriptions.size > 0;
    }

    /** Dispatches an event to this channel and all subscriptions. */
    handleEvent(event: string, data: unknown) {
        this.dispatchEvent(event, data);
        for (const sub of this.#subscriptions) {
            sub.dispatchEvent(event, data);
        }
    }

    /** Sends a call to the server and returns a promise that resolves to the server's response. */
    call<C extends Call>(op: C, data: ClientCalls[C]): Promise<ServerResultFor<ClientOp.Call, C>> {
        const [feature, call] = op.split(':');
        return this.service.send(ClientOp.Call, {
            ...data,
            channel: this.name,
            feature: feature as Feature,
            call,
        });
    }

    /** Closes this channel. */
    close() {
        this.#abort.abort();
    }

    /** CLAIMS */

    #claims: Claims = NO_CLAIMS;

    get claims(): Claims {
        return this.#claims;
    }

    claimAcquire(resource: string, force: boolean): Promise<boolean> {
        if (this.isConnected) {
            return this.call(Call.ClaimsAcquire, { resource, force });
        }
        return Promise.resolve(simulate_claim_acquire(this, this.#claims, resource, force, this.features.claims?.user ?? ""));
    }

    claimRelease(resource: string): Promise<boolean> {
        if (this.isConnected) {
            return this.call(Call.ClaimsRelease, { resource });
        }
        return Promise.resolve(simulate_claim_release(this, this.#claims, resource));
    }

    /** PRESENCE */

    #presence: string[] = [];

    get presence(): string[] {
        return this.#presence;
    }
}

/**
 * A Subscription is a single lease on a channel. It maps 1:1 to a `useChannel`
 * hook from the public API, and is responsible for managing the lifetime of
 * the subscription, including renewing the token and handling reconnection.
 */
class Subscription extends EventEmitter {
    static #nextSubscriptionId = 0;

    /** The unique ID of this subscription */
    readonly #subscriptionId: number = ++Subscription.#nextSubscriptionId;

    /** The logger instance for this subscription */
    readonly #logger: Logger;

    constructor(
        readonly service: Service,
        readonly signal: AbortSignal,
        readonly authorizer: Authorizer,
    ) {
        super();
        this.#logger = service.makeLogger(`S:${this.#subscriptionId}`);
        this.#run(); // Async

        // Reset the local claims when the channel claims are updated.
        this.addEventListener(ServerEvent.ChannelClaims, () => {
            this.#claims = NO_CLAIMS;
        });
    }

    /** The bound channel, if any */
    get channel(): Channel | undefined {
        return this.service.getChannel(this);
    }

    get isConnected(): boolean {
        return this.channel?.isConnected ?? false;
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
            this.service.addEventListener(ServerEvent.SocketUp, ({ detail: tokens }) => {
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

    /* CLAIMS */

    #claims: Claims = NO_CLAIMS;

    get claims(): Claims {
        return this.channel?.claims ?? this.#claims;
    }

    claimAcquire(resource: string, force: boolean): Promise<boolean> {
        const channel = this.channel;
        if (channel) {
            return channel.claimAcquire(resource, force);
        } else {
            return Promise.resolve(simulate_claim_acquire(this, this.#claims, resource, force, ""));
        }
    }

    claimRelease(resource: string): Promise<boolean> {
        const channel = this.channel;
        if (channel) {
            return channel.claimRelease(resource);
        } else {
            return Promise.resolve(simulate_claim_release(this, this.#claims, resource));
        }
    }
}

/**
 * A SubscriptionHandle is the public API for a subscription.
 * It is returned by the [`Service.subscribe`] method.
 */
export class SubscriptionHandle {
    /** The internal subscription state */
    #subscription: Subscription;

    /** @internal */
    constructor(subscription: Subscription) {
        this.#subscription = subscription;
    }

    /** Returns whether the subscription is canceled. */
    get canceled(): boolean {
        return this.#subscription.signal.aborted;
    }

    get isConnected(): boolean {
        return this.#subscription.isConnected;
    }

    /** Adds an event listener to the subscription. */
    addEventListener<E>(
        type: string,
        callback: (ev: CustomEvent<E>) => void,
        options?: AddEventListenerOptions
    ): void {
        if (this.canceled) {
            throw new Error('Cannot add event listener to a canceled subscription');
        }
        this.#subscription.addEventListener(type, callback as EventListener, options);
    }

    /* CLAIMS */

    get claims(): Claims {
        return this.#subscription.claims;
    }

    claimAcquire(resource: string, force: boolean): Promise<boolean> {
        return this.#subscription.claimAcquire(resource, force);
    }

    claimRelease(resource: string): Promise<boolean> {
        return this.#subscription.claimRelease(resource);
    }

    /* PRESENCE */

    get presence(): string[] {
        return this.#subscription.channel?.presence ?? [];
    }
}

function simulate_claim_acquire(eventEmitter: EventEmitter, claims: Claims, resource: string, force: boolean, username: string): boolean {
    if (!force && claims.claims[resource]) {
        return false;
    }

    claims.claims[resource] = username;
    if (!claims.own.includes(resource)) {
        claims.own.push(resource);
    }

    eventEmitter.dispatchEvent(ServerEvent.ChannelClaims, claims);
    return true;
}

function simulate_claim_release(eventEmitter: EventEmitter, claims: Claims, resource: string): boolean {
    if (!claims.own.includes(resource)) {
        return false;
    }

    delete claims.claims[resource];
    claims.own.splice(claims.own.indexOf(resource), 1);

    eventEmitter.dispatchEvent(ServerEvent.ChannelClaims, claims);
    return true;
}
