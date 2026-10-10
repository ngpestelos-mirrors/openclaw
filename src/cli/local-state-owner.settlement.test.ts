import { afterEach, expect, it, vi } from "vitest";
import {
  updateConfigMachineState,
  writeConfigMachineState,
} from "../state/config-machine-state-write.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";
import * as signalExit from "./signal-exit-barrier.js";

afterEach(() => vi.restoreAllMocks());

it("retains exact compensation custody through nested interruption without admitting new work", async () => {
  await withOpenClawTestState({ label: "local-owner-compensation" }, async (state) => {
    const interrupts: Array<() => void> = [];
    vi.spyOn(signalExit, "registerSignalExitGate").mockImplementation((_finished, interrupt) => {
      if (interrupt) {
        interrupts.push(interrupt);
      }
      return () => undefined;
    });
    const selected = { ...state.env };
    let settledAssertion: (() => void) | undefined;
    await runWithLocalStateOwner({
      method: "claws.update",
      params: {},
      target: "worker",
      env: selected,
      runLocal: async (outer) => {
        writeConfigMachineState("test.claw-compensation", "before", { env: outer.env });
        await runWithLocalStateOwner({
          method: "claws.update",
          params: {},
          target: "worker",
          env: selected,
          runLocal: async (inner) => {
            updateConfigMachineState<string>(
              "test.claw-compensation",
              (current) => {
                inner.assertCurrent();
                expect(current).toBe("before");
                return "accepted";
              },
              { env: inner.env },
            );
            for (const interrupt of interrupts) {
              interrupt();
            }
            expect(outer.assertCurrent).toThrow();
            expect(inner.assertCurrent).toThrow();
            const compensate = () =>
              updateConfigMachineState<string>(
                "test.claw-compensation",
                (current) => {
                  inner.assertSettlementCurrent();
                  if (current !== "accepted") {
                    throw new Error("The exact accepted value changed");
                  }
                  return "before";
                },
                { env: inner.env },
              );
            await inner.runSettlement(async () => {
              expect(inner.assertCurrent).toThrow();
              await runWithLocalStateOwner({
                method: "configState.mutate",
                params: {},
                target: "accepted config compensation",
                env: selected,
                runLocal: async (ancillary) => {
                  ancillary.assertCurrent();
                  expect(compensate()).toBe("before");
                },
              });
            });
            await expect(
              runWithLocalStateOwner({
                method: "claws.update",
                params: {},
                target: "new",
                env: selected,
                runLocal: async () => {
                  throw new Error("Unexpected new admission");
                },
              }),
            ).rejects.not.toThrow("Unexpected new admission");
            selected.OPENCLAW_CONFIG_PATH = state.path("different.json");
            expect(inner.assertSettlementCurrent).toThrow(/Selected state root changed/);
            selected.OPENCLAW_CONFIG_PATH = state.env.OPENCLAW_CONFIG_PATH;
            settledAssertion = inner.assertSettlementCurrent;
          },
        });
      },
    });
    expect(settledAssertion).toBeDefined();
    expect(settledAssertion!).toThrow();
  });
});
