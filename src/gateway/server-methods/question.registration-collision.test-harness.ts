import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as registration from "./question.durable-registration.js";
import { installQuestionTestHooks, manager, requestParams } from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

type Fixture = {
  runtime: GatewayClient;
  call: (
    method: string,
    params: Record<string, unknown>,
    client?: GatewayClient,
  ) => Promise<unknown[]>;
  close: () => Promise<void>;
};

export function registerQuestionCollisionTests(
  createFixture: (durable?: boolean) => Promise<Fixture>,
) {
  installQuestionTestHooks();
  describe("durable registration global ID ownership", () => {
    it.each(["same-agent", "other-agent"])(
      "rejects an existing %s transient ID before worker registration",
      async (source) => {
        await withOpenClawTestState({ scenario: "minimal" }, async () => {
          const f = await createFixture(true);
          const spy = vi.spyOn(registration, "registerDurableQuestion");
          try {
            manager.request({
              id: "collision",
              questions: requestParams.questions,
              timeoutMs: 1000,
              agentId: source === "same-agent" ? requestParams.agentId : "other",
            });
            const response = await f.call(
              "question.request",
              { ...requestParams, id: "collision", durable: true },
              f.runtime,
            );
            expect(response[0]).toBe(false);
            expect(spy).not.toHaveBeenCalled();
            expect(manager.hasDurableCustody("collision")).toBe(false);
          } finally {
            spy.mockRestore();
            await f.close();
          }
        });
      },
    );

    it("reserves before worker awaits so competing durable and transient requests cannot orphan custody", async () => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const f = await createFixture(true);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const original = registration.registerDurableQuestion;
        const spy = vi
          .spyOn(registration, "registerDurableQuestion")
          .mockImplementation(async (params) => {
            entered.resolve();
            await release.promise;
            return original(params);
          });
        try {
          const pending = f.call(
            "question.request",
            { ...requestParams, id: "reserved", durable: true },
            f.runtime,
          );
          await entered.promise;
          expect(() => manager.request({ id: "reserved", questions: [], timeoutMs: 1000 })).toThrow(
            "already exists",
          );
          const duplicate = await f.call(
            "question.request",
            { ...requestParams, id: "reserved", durable: true },
            f.runtime,
          );
          expect(duplicate[0]).toBe(false);
          expect(spy).toHaveBeenCalledTimes(1);
          release.resolve();
          expect((await pending)[0]).toBe(true);
          expect(manager.hasDurableCustody("reserved")).toBe(true);
        } finally {
          release.resolve();
          spy.mockRestore();
          await f.close();
        }
      });
    });
  });
}
