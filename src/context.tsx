import React, { createContext, useEffect, useRef } from 'react';
import { Service } from './service';
import { Level } from './logger';

export const Context = createContext<Service | null>(null);

export type HedwigProviderProps = {
    url: string;
    verbosity?: Level;
    children: React.ReactNode;
}

export function HedwigProvider({ url, verbosity, children }: HedwigProviderProps) {
    const service = useRef<Service>(null);
    if (service.current === null) {
        service.current = new Service(url, verbosity);
    }
    // FIXME: Changing any of the props will not reset the service instance.
    // There should never be a reason to change the URL or verbosity anyway...

    useEffect(() => () => service.current!.terminate(), []);

    return (
        <Context.Provider value={service.current}>
            {children}
        </Context.Provider>
    );
}
