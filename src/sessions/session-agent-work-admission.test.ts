import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { readAgentDeletionJournalStatusInWorker } from "../state/agent-deletion-journal.read.js";
import {
  beginSessionWorkAdmission,
  closeAgentWorkAdmissions,
  collectActiveAgentSessionWorkAdmissions,
  startAgentWorkAdmissionInterruption,
  startSessionWorkAdmissionInterruption,
} from "./session-lifecycle-admission.js";

// mock-isolation: Admission decisions use controlled journal status without opening SQLite.
vi.mock("../state/agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalStatusInWorker: vi.fn(async () => "absent"),
}));

it("fences unseen agent sessions and joins exact admitted work without blocking another state", async () => {
  const target = { agentId: "worker", env: { OPENCLAW_STATE_DIR: "/agent-admission-state-a" } };
  const scope = "agent:worker";
  const interrupted = createDeferred();
  const active = await beginSessionWorkAdmission({
    ...target,
    scope,
    identities: ["sessionless-run"],
    assertAllowed: () => {},
    onInterrupt: () => interrupted.resolve(),
  });
  const pendingStarted = createDeferred();
  const releasePending = createDeferred();
  const pending = beginSessionWorkAdmission({
    ...target,
    scope,
    identities: ["pending-run"],
    assertAllowed: async () => {
      pendingStarted.resolve();
      await releasePending.promise;
    },
  });
  const reason = new Error("agent deletion began");
  const pendingOutcome = expect(pending).rejects.toBe(reason);
  await pendingStarted.promise;
  const reopen = closeAgentWorkAdmissions({ ...target, reason });
  let other: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
  try {
    await pendingOutcome;
    await expect(
      beginSessionWorkAdmission({
        ...target,
        scope: "previously-unseen-store",
        identities: ["new-session"],
        assertAllowed: () => {},
      }),
    ).rejects.toBe(reason);
    other = await beginSessionWorkAdmission({
      ...target,
      env: { OPENCLAW_STATE_DIR: "/agent-admission-state-b" },
      scope,
      identities: ["same-agent-other-state"],
      assertAllowed: () => {},
    });
    expect(collectActiveAgentSessionWorkAdmissions(target).get(scope)).toEqual(
      new Set(["sessionless-run"]),
    );
    const drain = startAgentWorkAdmissionInterruption({ ...target, reason });
    await interrupted.promise;
    let settled = false;
    void drain.released.then(() => {
      settled = true;
    });
    expect(await active.run(async () => "cancellation checkpoint")).toBe("cancellation checkpoint");
    expect(settled).toBe(false);
    active.release();
    await drain.released;
    expect(other.isActive()).toBe(true);
  } finally {
    releasePending.resolve();
    await pending.catch(() => {});
    active.release();
    other?.release();
    reopen();
  }
});

it("rejects new agent work after a durable deletion survives restart", async () => {
  vi.mocked(readAgentDeletionJournalStatusInWorker).mockResolvedValueOnce("pending");
  let admitted: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
  try {
    await expect(
      beginSessionWorkAdmission({
        agentId: "worker",
        env: { OPENCLAW_STATE_DIR: "/agent-admission-restart" },
        scope: "agent:worker",
        identities: ["new-run-after-restart"],
        assertAllowed: () => {},
      }).then((lease) => {
        admitted = lease;
        return lease;
      }),
    ).rejects.toThrow("deletion is in progress");
  } finally {
    admitted?.release();
  }
});

it("refuses deletion from the target agent's own admitted turn before closing ingress", async () => {
  const target = { agentId: "worker", env: { OPENCLAW_STATE_DIR: "/agent-admission-self-delete" } };
  const params = {
    ...target,
    scope: "agent:worker",
    identities: ["self-delete-turn"],
    assertAllowed: () => {},
  };
  const active = await beginSessionWorkAdmission(params);
  try {
    await expect(
      active.run(async () => closeAgentWorkAdmissions({ ...target, reason: new Error("delete") })),
    ).rejects.toThrow("Cannot delete an agent from its own active turn");
    const following = await beginSessionWorkAdmission({
      ...params,
      identities: ["following-turn"],
    });
    following.release();
    expect(active.isActive()).toBe(true);
  } finally {
    active.release();
  }
});

it.each(["agent", "session"] as const)(
  "rechecks %s drain authority between admitted cancellations",
  async (scope) => {
    const target = {
      agentId: "worker",
      env: { OPENCLAW_STATE_DIR: "/agent-admission-revoked" },
      scope: "agent:worker",
      identities: ["shared-session"],
      assertAllowed: () => {},
    };
    let current = true;
    const first = await beginSessionWorkAdmission({
      ...target,
      onInterrupt: () => {
        current = false;
      },
    });
    const laterInterrupt = vi.fn();
    const later = await beginSessionWorkAdmission({ ...target, onInterrupt: laterInterrupt });
    const assertCurrent = () => {
      if (!current) {
        throw new Error("deletion journal replaced");
      }
    };
    try {
      const drain =
        scope === "agent"
          ? startAgentWorkAdmissionInterruption({ ...target, assertCurrent })
          : startSessionWorkAdmissionInterruption({ ...target, assertCurrent });
      const settled = vi.fn();
      void drain.released.then(settled, settled);
      await first.run(async () => "cancellation cleanup");
      expect(settled).not.toHaveBeenCalled();
      expect(laterInterrupt).not.toHaveBeenCalled();
      expect(later.isActive()).toBe(true);
      first.release();
      await expect(drain.released).rejects.toThrow("deletion journal replaced");
    } finally {
      first.release();
      later.release();
    }
  },
);
