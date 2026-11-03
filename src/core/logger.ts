/** Verbosity level */
export enum Level {
    /** No logging */
    Off = 0,
    /** Only essential messages (errors, warnings) */
    Essential = 1,
    /** Informative messages (e.g. user actions) */
    Informative = 2,
    /** Detailed debugging information */
    Detailed = 3,
}

type LogMethod = 'debug' | 'info' | 'warn' | 'error';

export class Logger implements LoggerInterface {
    constructor(
        readonly parent: LoggerInterface,
        public prefix: string,
    ) { }

    debug(message: string, ...args: any[]): void {
        this.parent.debug(`[${this.prefix}] ${message}`, ...args);
    }

    info(message: string, ...args: any[]): void {
        this.parent.info(`[${this.prefix}] ${message}`, ...args);
    }

    warn(message: string, ...args: any[]): void {
        this.parent.warn(`[${this.prefix}] ${message}`, ...args);
    }

    error(message: string, ...args: any[]): void {
        this.parent.error(`[${this.prefix}] ${message}`, ...args);
    }

    withPrefix(prefix: string): Logger {
        return new Logger(this, prefix);
    }
}

export class ConsoleLogger implements LoggerInterface {
    constructor(
        public verbosity: Level,
    ) { }

    #log(level: Level, method: LogMethod, message: string, ...args: any[]): void {
        if (this.verbosity >= level) {
            console[method](message, ...args);
        }
    }

    debug(message: string, ...args: any[]): void {
        this.#log(Level.Detailed, 'debug', message, ...args);
    }

    info(message: string, ...args: any[]): void {
        this.#log(Level.Informative, 'info', message, ...args);
    }

    warn(message: string, ...args: any[]): void {
        this.#log(Level.Essential, 'warn', message, ...args);
    }

    error(message: string, ...args: any[]): void {
        this.#log(Level.Essential, 'error', message, ...args);
    }

    withPrefix(prefix: string): Logger {
        return new Logger(this, prefix);
    }
}

export interface LoggerInterface {
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;

    withPrefix(prefix: string): Logger;
}
