import React, { createContext, useMemo } from 'react';
import { Service } from './service';
import { Level } from './logger';

export const Context = createContext<Service | null>(null);

export type HedwigProviderProps = {
    url: string;
    verbosity?: Level;
    children: React.ReactNode;
}

export function HedwigProvider({ url, verbosity, children }: HedwigProviderProps) {
    const service = useMemo(() => new Service(url, verbosity), [url, verbosity]);

    return (
        <Context.Provider value={service}>
            {children}
        </Context.Provider>
    );
}
