import type { Locale } from "../../i18n/lib/registry.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import { projectSource } from "./projection.ts";

type TranslationSource = {
  getLocale(): Locale;
  t(key: string, params?: Record<string, string>): string;
  subscribe(listener: () => void): () => void;
};

/** A revision also invalidates when a catalog changes without a locale change. */
export function projectI18n(source: TranslationSource) {
  const projection = projectSource(source, {
    read: (current) => current,
    subscribe: (current, notify) => current.subscribe(notify),
    equality: "revision",
  });
  return {
    ...projection,
    locale: () => projection.read().getLocale(),
    t: (key: string, params?: Record<string, string>) => projection.read().t(key, params),
  };
}

/** Solid consumers retain t("key") without loading signals in the existing Lit entry. */
export const t = projectI18n(i18n).t;
