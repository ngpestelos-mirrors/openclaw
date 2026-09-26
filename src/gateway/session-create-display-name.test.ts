import { describe, expect, it } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";
import type { PreparedGatewaySessionLifecycle } from "./session-create-service.types.js";

describe("session creation display titles", () => {
  it.each(["durable", "incognito", "shared"])(
    "reserves concurrent explicit labels atomically in %s storage",
    async (storage) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const incognito = storage === "incognito";
        const storePath = storage === "shared" ? state.statePath("shared.sqlite") : undefined;
        const cfg = { agents: { entries: { main: {}, other: {} } }, session: { store: storePath } };
        const prepared = createDeferredCore();
        let preparing = 0;
        const keys = ["first", "second"].map(
          (name, index) =>
            `agent:${storage === "shared" && index === 1 ? "other" : "main"}:dashboard:${incognito ? "incognito-" : ""}${name}`,
        );
        const outcomes = await Promise.all(
          keys.map((key) => {
            let joined = false;
            const withCommit: PreparedGatewaySessionLifecycle["withCommit"] = async (run) => {
              if (!joined) {
                joined = true;
                if (++preparing === 2) {
                  prepared.resolve();
                }
                await prepared.promise;
              }
              return run(() => {});
            };
            return createGatewaySession({
              cfg,
              key,
              incognito,
              label: " Shared label ",
              commandSource: "test",
              operatorRoleActor: { kind: "system" },
              prepareLifecycle: async () => ({ ok: true, value: { withCommit } }),
            });
          }),
        );
        expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
        expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", message: "label already in use: Shared label" },
        });
        for (const [index, key] of keys.entries()) {
          const stored = loadSessionEntry({ sessionKey: key, storePath });
          if (outcomes[index]?.ok) {
            expect(stored?.label).toBe("Shared label");
          } else {
            expect(stored?.label).toBeUndefined();
          }
        }
      });
    },
  );

  it("rejects a label claimed by a raw metadata edit after creation preparation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const siblingKey = "agent:main:sibling";
      const sibling = await createGatewaySession({
        cfg: {},
        key: siblingKey,
        label: "Old label",
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
      });
      expect(sibling.ok).toBe(true);
      if (!sibling.ok) {
        throw new Error(sibling.error.message);
      }
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const withCommit: PreparedGatewaySessionLifecycle["withCommit"] = async (run) => {
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(JSON.stringify({ ...sibling.entry, label: "Claimed" }), siblingKey);
        return run(() => {});
      };
      await expect(
        createGatewaySession({
          cfg: {},
          key: "agent:main:contender",
          label: "Claimed",
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
          prepareLifecycle: async () => ({ ok: true, value: { withCommit } }),
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "label already in use: Claimed" },
      });
      expect(loadSessionEntry({ sessionKey: "agent:main:contender" })).toBeUndefined();
    });
  });

  it.each([
    { kind: "trimmed", title: "  Native title  ", expected: "Native title" },
    { kind: "empty", title: "", expected: undefined },
    { kind: "blank", title: " \n\t ", expected: undefined },
    { kind: "long", title: ` ${"x".repeat(600)} `, expected: "x".repeat(500) },
    {
      kind: "split surrogate",
      title: ` ${"界".repeat(499)}${"🦞".repeat(300)} `,
      expected: "界".repeat(499),
    },
    { kind: "whole surrogates", title: "🦞".repeat(300), expected: "🦞".repeat(250) },
  ])("bounds a create-only $kind title snapshot", async ({ title, expected }) => {
    await withOpenClawTestState({ label: "create-display-title" }, async () => {
      const first = await createGatewaySession({
        cfg: {},
        key: "agent:main:title-first",
        displayName: title,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
      });
      const second = await createGatewaySession({
        cfg: {},
        key: "agent:main:title-second",
        displayName: title,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
      });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        throw new Error("Display titles must not reject session creation");
      }
      expect(first.entry.displayName).toBe(expected);
      expect(second.entry.displayName).toBe(expected);
      expect(first.entry.label).toBeUndefined();
      expect(second.entry.label).toBeUndefined();
      expect(first.entry.sessionId).not.toBe(second.entry.sessionId);

      const repeated = await createGatewaySession({
        cfg: {},
        key: first.key,
        displayName: "Do not overwrite or backfill existing rows",
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
      });
      expect(repeated).toMatchObject({
        ok: true,
        entry: { sessionId: first.entry.sessionId },
      });
      if (!repeated.ok) {
        throw new Error(repeated.error.message);
      }
      expect(repeated.entry.displayName).toBe(expected);
    });
  });

  it("preserves explicit labels and still rejects equivalent duplicate labels", async () => {
    await withOpenClawTestState({ label: "create-title-with-label" }, async () => {
      const create = (key: string, label: string) =>
        createGatewaySession({
          cfg: {},
          key,
          label,
          displayName: "Non-unique native title",
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
        });
      const first = await create("agent:main:operator-first", "Operator label");
      expect(first).toMatchObject({
        ok: true,
        entry: { label: "Operator label", displayName: "Non-unique native title" },
      });
      await expect(
        create("agent:main:operator-second", "  Operator label  "),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "label already in use: Operator label" },
      });
    });
  });
});
