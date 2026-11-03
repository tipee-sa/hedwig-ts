export abstract class EventEmitter {
    #eventTarget: EventTarget = new EventTarget();

    dispatchEvent(event: string, detail: unknown): boolean {
        return this.#eventTarget.dispatchEvent(new CustomEvent(event, { detail }));
    }

    addEventListener(type: string, callback: (e: CustomEvent) => void, options?: AddEventListenerOptions): void {
        this.#eventTarget.addEventListener(type, callback as EventListener, options);
    }
}
