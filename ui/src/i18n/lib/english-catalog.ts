import { registerListener } from "../../../../src/shared/listeners.js";
import type { TranslationMap } from "./types.ts";

const listeners = new Set<() => void>();

export function subscribeEnglishCatalogChanges(listener: () => void): () => void {
  return registerListener(listeners, listener);
}

/** Keep static catalog metadata separate from runtime registration and its invalidation. */
export function defineEnglishCatalog<T, Catalog extends TranslationMap>(
  register: () => T,
  metadata: { catalog: Catalog },
) {
  let registered = false;
  return Object.assign(() => {
    const result = register();
    // Static catalogs publish once. Repeated registrations still restore their copy
    // for existing callers, without invalidating a render that registers its fallback.
    if (!registered) {
      registered = true;
      for (const listener of listeners) {
        listener();
      }
    }
    return result;
  }, metadata);
}
