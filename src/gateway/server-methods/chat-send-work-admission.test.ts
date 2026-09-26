import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  captureGatewayDeviceRevocation,
  retainGatewayDeviceRevocation,
} from "../device-revocation.js";
import { createChatSendWorkAdmission } from "./chat-send-work-admission.js";

describe("retained chat work admission", () => {
  it.each([false, true])(
    "keeps caller custody through collected work (cleanup failure: %s)",
    async (failCleanup) => {
      const caller = captureGatewayDeviceRevocation(
        {},
        { deviceId: "device", role: "operator" },
        () => true,
      );
      const releaseAdmission = vi.fn();
      const warn = vi.fn();
      const work = createChatSendWorkAdmission({
        admission: { release: releaseAdmission },
        releaseCallerAuthority: retainGatewayDeviceRevocation(caller.isCurrent),
        logGateway: { warn },
      });
      const settlement = createDeferredCore();
      const finishPendingInput = vi.fn(async () => {
        await settlement.promise;
        if (failCleanup) {
          throw new Error("pending input write failed");
        }
      });
      work.setPendingInputCleanup(finishPendingInput);
      const releaseCollectedTurn = work.retain();
      caller.release();
      await work.release();
      await work.release();

      expect(work.isActive()).toBe(true);
      expect(caller.isCurrent()).toBe(true);
      expect(finishPendingInput).not.toHaveBeenCalled();
      expect(releaseAdmission).not.toHaveBeenCalled();

      const released = releaseCollectedTurn();
      const duplicateRelease = releaseCollectedTurn();
      expect(work.isActive()).toBe(false);
      expect(caller.isCurrent()).toBe(true);
      expect(releaseAdmission).not.toHaveBeenCalled();
      settlement.resolve();
      await Promise.all([released, duplicateRelease]);
      expect(caller.isCurrent()).toBe(false);
      expect(finishPendingInput).toHaveBeenCalledOnce();
      expect(releaseAdmission).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledTimes(failCleanup ? 1 : 0);
      expect(() => work.retain()).toThrow("cannot retain a released chat work admission");
    },
  );
});
