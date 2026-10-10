import {
  createMemo,
  createSignal,
  getObserver,
  getOwner,
  onCleanup,
  untrack,
} from "@solidjs/signals";

type Dispose = () => void;

export type SourceContract<S, T> = {
  read(source: S): T;
  subscribe(source: S, notify: () => void): Dispose;
  /** Mutable snapshots invalidate by notification, never by object identity. */
  equality: "revision" | ((previous: T, next: T) => boolean);
};

export type SourceProjection<S, T> = {
  readonly equality: SourceContract<S, T>["equality"];
  readonly read: () => T;
  readonly revision: () => number;
  subscribe(listener: () => void): Dispose;
  replaceSource(source: S): void;
  dispose(): void;
};

/** A read-through view of an owner. This never becomes an authoritative store. */
export function projectSource<S, T>(
  initialSource: S,
  contract: SourceContract<S, T>,
): SourceProjection<S, T> {
  let source = initialSource;
  let value = untrack(() => contract.read(source));
  let lastRead = value;
  let disposed = false;
  let observed = false;
  let generation = 0;
  let connected = false;
  let disconnect: Dispose | undefined;
  const listeners = new Set<() => void>();
  const release = () => {
    generation += 1;
    connected = false;
    const cleanup = disconnect;
    disconnect = undefined;
    cleanup?.();
  };
  const [revision, setRevision] = createSignal(0, {
    ownedWrite: true,
  });
  const publish = () => {
    setRevision((previous) => previous + 1);
    const current = generation;
    for (const listener of [...listeners]) {
      if (disposed || generation !== current) {
        break;
      }
      if (listeners.has(listener)) {
        listener();
      }
    }
  };
  const connect = () => {
    if (connected || disposed) {
      return;
    }
    connected = true;
    const current = ++generation;
    try {
      const cleanup = contract.subscribe(source, () => {
        if (disposed || generation !== current) {
          return;
        }
        const next = untrack(() => contract.read(source));
        const changed = contract.equality === "revision" || !contract.equality(value, next);
        value = next;
        lastRead = next;
        if (changed) {
          publish();
        }
      });
      // A synchronous subscription callback can replace/dispose this projection.
      if (disposed || generation !== current) {
        cleanup();
      } else {
        disconnect = cleanup;
        value = untrack(() => contract.read(source));
        lastRead = value;
      }
    } catch (error) {
      release();
      throw error;
    }
  };
  // A lazy, dependency-free memo gives probes a temporary lifetime and tracked
  // readers a shared lifetime. It never reruns merely because the owner publishes.
  const observation = createMemo(
    () => {
      observed = true;
      onCleanup(() => {
        observed = false;
        if (listeners.size === 0) {
          release();
        }
      });
      untrack(connect);
      return true;
    },
    { lazy: true },
  );
  const observe = () => {
    const current = revision();
    if (!disposed && getObserver()) {
      observation();
    }
    return current;
  };
  const dispose = () => {
    if (disposed) {
      return;
    }
    setRevision(untrack(revision));
    disposed = true;
    listeners.clear();
    release();
  };
  if (getOwner()) {
    onCleanup(dispose);
  }
  return {
    equality: contract.equality,
    read() {
      observe();
      if (!disposed) {
        lastRead = untrack(() => contract.read(source));
      }
      return lastRead;
    },
    revision: observe,
    subscribe(listener) {
      if (disposed) {
        return () => {};
      }
      // Each subscription has its own identity, including duplicate callbacks.
      const entry = () => listener();
      listeners.add(entry);
      try {
        connect();
      } catch (error) {
        listeners.delete(entry);
        throw error;
      }
      return () => {
        listeners.delete(entry);
        if (!observed && listeners.size === 0) {
          release();
        }
      };
    },
    replaceSource(next) {
      if (disposed || Object.is(source, next)) {
        return;
      }
      release();
      source = next;
      value = untrack(() => contract.read(source));
      lastRead = value;
      if (observed || listeners.size > 0) {
        connect();
      }
      publish();
    },
    dispose,
  };
}

type EventListener<E> = ((event: E) => void) | ((event: E) => Promise<void>);

export type EventProjection<S, E> = {
  subscribe(listener: EventListener<E>): Dispose;
  replaceSource(source: S): void;
  dispose(): void;
};

/** Events are synchronous, ordered, and never coalesced or replayed as state. */
export function projectEvents<S, E>(
  initialSource: S,
  contract: { subscribe(source: S, listener: (event: E) => void | Promise<void>): Dispose },
): EventProjection<S, E> {
  let source = initialSource;
  let disposed = false;
  let generation = 0;
  let connected = false;
  let disconnect: Dispose | undefined;
  const listeners = new Set<EventListener<E>>();
  const release = () => {
    generation += 1;
    connected = false;
    const cleanup = disconnect;
    disconnect = undefined;
    cleanup?.();
  };
  const connect = () => {
    if (connected || disposed || listeners.size === 0) {
      return;
    }
    connected = true;
    const current = ++generation;
    try {
      const cleanup = contract.subscribe(source, (event): void | Promise<void> => {
        const pending: Promise<void>[] = [];
        const failures: unknown[] = [];
        for (const listener of [...listeners]) {
          if (disposed || generation !== current) {
            break;
          }
          if (listeners.has(listener)) {
            try {
              const result = listener(event);
              if (result && typeof result.then === "function") {
                pending.push(result);
              }
            } catch (error) {
              failures.push(error);
            }
          }
        }
        if (pending.length > 0) {
          return Promise.allSettled([
            ...pending,
            ...failures.map((error) => Promise.reject(error)),
          ]).then((results) => {
            const failed = results.find((result) => result.status === "rejected");
            if (failed) {
              throw failed.reason;
            }
          });
        }
        if (failures.length > 0) {
          throw failures[0];
        }
        return undefined;
      });
      if (disposed || generation !== current) {
        cleanup();
      } else {
        disconnect = cleanup;
      }
    } catch (error) {
      release();
      throw error;
    }
  };
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    listeners.clear();
    release();
  };
  if (getOwner()) {
    onCleanup(dispose);
  }
  return {
    subscribe(listener) {
      if (disposed) {
        return () => {};
      }
      const entry = (event: E) => listener(event);
      listeners.add(entry);
      try {
        connect();
      } catch (error) {
        listeners.delete(entry);
        throw error;
      }
      return () => {
        listeners.delete(entry);
        if (listeners.size === 0) {
          release();
        }
      };
    },
    replaceSource(next) {
      if (disposed || Object.is(source, next)) {
        return;
      }
      release();
      source = next;
      connect();
    },
    dispose,
  };
}
