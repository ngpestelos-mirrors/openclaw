import { afterAll, beforeAll } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";

/** Tool-construction fixtures use the same canonical rows as running sessions. */
export function useToolPolicySessionFixture(entries: Record<string, SessionEntry>): void {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  beforeAll(async () => {
    state = await createOpenClawTestState({ label: "tool-policy-sessions" });
    for (const [sessionKey, entry] of Object.entries(entries)) {
      await replaceSessionEntry({ agentId: "main", sessionKey }, entry);
    }
  });
  afterAll(async () => await state?.cleanup());
}
