import { access } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as gatewayCall from "../gateway/call.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import * as gatewayOwner from "../infra/gateway-state-owner.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runClawsAddCommand, runClawsRemoveCommand } from "./claws-cli.runtime.js";
import { runClawsMigrateCommand } from "./claws-migrate-cli.runtime.js";
import { runClawsUpdateCommand } from "./claws-update-cli.runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["add", "update", "remove", "migrate"] as const)(
  "never replays %s locally when the serving owner cannot accept it",
  async (command) => {
    await withOpenClawTestState({ label: `claw-refuse-${command}` }, async (state) => {
      vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
      vi.spyOn(gatewayOwner, "captureGatewayStateOwner").mockReturnValue(undefined);
      vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
        pid: process.pid,
        ownerId: "synthetic-owner",
        createdAt: new Date().toISOString(),
        port: 19092,
      });
      const transport = vi
        .spyOn(gatewayCall, "callGateway")
        .mockRejectedValue(new Error("Gateway does not support this method"));
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const options = { yes: true, planIntegrity: "sha256:consented", json: true };
      const run =
        command === "add"
          ? runClawsAddCommand
          : command === "update"
            ? runClawsUpdateCommand
            : command === "remove"
              ? runClawsRemoveCommand
              : runClawsMigrateCommand;
      await expect(run("worker", options, runtime)).rejects.toThrow(
        /No local mutation was attempted/,
      );
      expect(transport).toHaveBeenCalledTimes(command === "migrate" ? 0 : 1);
      await expect(access(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  },
);
