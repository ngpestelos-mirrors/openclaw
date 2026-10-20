import { describe, expect, it } from "vitest";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { projectSubagentRunForSessionList } from "./subagent-delivery-state.js";
import {
  getSubagentRunByChildSessionKeyFromRuns,
  buildSubagentRunReadIndexFromRuns,
  countActiveRunsForSessionFromRuns,
  listRunsForControllerFromRuns,
} from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { buildSubagentRunView } from "./subagent-run-view.js";

function makeRun(overrides: SubagentRunRecordOverrides): SubagentRunRecord {
  return createSubagentRunRecord({
    childSessionKey: `agent:main:subagent:${overrides.runId}`,
    ...overrides,
  });
}

function toRunMap(runs: SubagentRunRecord[]) {
  return new Map(runs.map((run) => [run.runId, run]));
}

function rawOwners(
  owners: (string | undefined)[],
  facts: (index: number) => Partial<SubagentRunRecord>,
) {
  return owners.map((childAgentId, index) =>
    makeRun({
      runId: childAgentId ?? "legacy",
      childSessionKey: "global",
      childAgentId,
      ...facts(index),
    }),
  );
}

describe("recorded child owner lookup", () => {
  it("preserves distinct owners and unresolved diagnostic rows", () => {
    const now = Date.now();
    const owners = ["main", undefined, "research"];
    const view = buildSubagentRunView({
      runs: rawOwners(owners, (index) => ({ createdAt: now - index })),
      recentMinutes: 30,
      countPendingDescendantRuns: () => 0,
      now,
    });
    expect(view.latest.map((entry) => entry.runId)).toEqual(["main", "legacy", "research"]);
  });

  it.each([
    [undefined, undefined],
    ["research", "research"],
    ["invalid/owner", undefined],
  ])("retains legacy raw rows while selecting owner %s", (owner, expected) => {
    const runs = toRunMap(
      rawOwners([undefined, "main", "research"], (index) => ({ generation: index + 1 })),
    );
    expect(getSubagentRunByChildSessionKeyFromRuns(runs, "global", owner)?.runId).toBe(expected);
  });

  it.each([
    ["agent:research:main", undefined, "research", true],
    ["agent:research:main", "main", "research", true],
    ["agent:research:main", "main", "main", false],
    ["global", "research", "research", true],
    ["global", "research", "main", false],
    ["global", undefined, "research", false],
  ] as const)(
    "scopes controller %s with requester owner %s to agent %s (matches=%s)",
    (controllerSessionKey, requesterAgentId, controllerAgentId, matches) => {
      const run = makeRun({ runId: "controlled", controllerSessionKey, requesterAgentId });
      expect(
        listRunsForControllerFromRuns(toRunMap([run]), controllerSessionKey, controllerAgentId),
      ).toEqual(matches ? [run] : []);
    },
  );

  it.each([
    ["agent:invalid/owner:child", undefined, "main"],
    ["agent:main:", "main", "main"],
    ["agent:main:child", "research", "main"],
    ["global", "invalid/owner", "main"],
    ["agent:main:subagent:qualified", undefined, "research"],
  ])(
    "refuses invalid ownership: key %s, recorded %s, selected %s",
    (childSessionKey, childAgentId, owner) => {
      const run = makeRun({ runId: "invalid", childSessionKey, childAgentId });
      expect(
        getSubagentRunByChildSessionKeyFromRuns(toRunMap([run]), run.childSessionKey, owner),
      ).toBeNull();
    },
  );
});

describe("suspended descendant accounting", () => {
  it.each(["none", "running", "pending"] as const)(
    "accounts for %s grandchildren below a suspended child",
    (status) => {
      const now = Date.now();
      const hasGrandchild = status !== "none";
      const parent = makeRun({ runId: "parent", endedAt: now - (hasGrandchild ? 3_000 : 2_000) });
      const child = makeRun({
        runId: "suspended-child",
        requesterSessionKey: parent.childSessionKey,
        endedAt: now - (hasGrandchild ? 2_000 : 1_000),
        delivery: {
          status: "suspended",
          suspendedAt: now,
          ...(hasGrandchild ? {} : { suspendedReason: "permanent_failure" as const }),
        },
      });
      const entries = [parent, child];
      if (hasGrandchild) {
        entries.push(
          makeRun({
            runId: "grandchild",
            requesterSessionKey: child.childSessionKey,
            createdAt: now - 1_000,
            startedAt: now - 1_000,
            ...(status === "running"
              ? { delivery: { status: "suspended", suspendedAt: now } }
              : { endedAt: now, delivery: { status: "pending" } }),
          }),
        );
      }
      const runs = toRunMap(entries);
      expect(countActiveRunsForSessionFromRuns(runs, parent.requesterSessionKey)).toBe(
        hasGrandchild ? 1 : 0,
      );
      for (const projected of [false, true]) {
        const index = buildSubagentRunReadIndexFromRuns({
          runs: projected
            ? new Map([...runs].map(([id, run]) => [id, projectSubagentRunForSessionList(run)]))
            : runs,
        });
        const count = (excludeSuspendedDelivery = false) =>
          index.countPendingDescendantRuns(parent.childSessionKey, { excludeSuspendedDelivery });
        const pending = hasGrandchild ? 2 : 1;
        expect([count(), count(true), count()]).toEqual([pending, pending - 1, pending]);
      }
      expect(runs.get(child.runId)).toBe(child);
      expect(child.cleanupCompletedAt).toBeUndefined();
      expect(child.delivery?.status).toBe("suspended");
    },
  );
});
