import { HedwigToken } from '../token';
import { Call, ClientMessageMap, ClientOp, ServerEvent, ServerMessage, ServerResultFor } from '../proto';
import { Promise_withResolvers, PromiseWithResolvers } from '../util';
import { ConsoleLogger, Level, Logger } from '../logger';
import { EventEmitter } from './emitter';
import { ERR_DISCONNECTED, ServerError } from './errors';
import { Channel } from './channel';
import { Authorizer, Subscription } from './subscription';
import { SubscriptionHandle } from './subscriptionHandle';

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
     * If `signal` is aborted before the promise resolves, the promise is
     * rejected with the signal's reason, and the underlying event listener is
     * cancelled.
     */
    upPromise(signal: AbortSignal): Promise<void> {
        if (this.isConnected) {
            return Promise.resolve();
        }
        return this.eventPromise(ServerEvent.SocketUp, signal);
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

        const deferred = Promise_withResolvers<ServerResultFor<O, T>>();
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
