import type { UpdateFailureFact } from "./update-failure-facts.js";

/** Render producer-redacted facts in both server and browser reports. */
export function formatUpdateFailureFact(fact: UpdateFailureFact): string {
  return `Failing check ${fact.check} (${fact.code})${fact.pluginId ? `; plugin ${fact.pluginId}` : ""}${fact.affectedKey ? `; key ${fact.affectedKey}` : ""}${fact.message ? `: ${fact.message}` : ""}`;
}
