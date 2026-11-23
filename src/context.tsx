import React, { createContext, useEffect, useState } from 'react';
import { Service } from './service';
import { Level } from './logger';

export const Context = createContext<Service | null>(null);

export type HedwigProviderProps = {
    /**
     * The URL of the Hedwig server. It is only read on mount: to connect to
     * another server, remount the provider, e.g. with `key={url}`.
     */
    url: string;
    /** The verbosity of the logs. It applies as soon as it changes. */
    verbosity?: Level;
    children: React.ReactNode;
}

export function HedwigProvider({ url, verbosity, children }: HedwigProviderProps) {
    // A single service for the whole life of the provider. `useMemo` would not
    // guarantee it: React may drop its cache, and every subscription would then
    // move to a new service and release its claims.
    const [service] = useState(() => new Service(url, verbosity));

    useEffect(() => {
        service.verbosity = verbosity ?? Level.Essential;
    }, [service, verbosity]);

    return (
        <Context.Provider value={service}>
            {children}
        </Context.Provider>
    );
}
