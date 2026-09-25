import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ExecApprovalRequestPayload } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { installTestApprovalClock } from "../exec-approval-manager.test-support.js";
import { createExecApprovalRecord } from "../exec-approval-registration.js";
import * as store from "../operator-approval-store.js";
import { createApprovalHandlers } from "./approval.js";
import {
  createApprovalInvocation,
  createClient,
  getOperatorApproval,
  corruptDurableApprovalPresentation,
} from "./approval.test-support.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "approval-physical-owner" });
});
beforeEach(() => state.applyEnv());
afterEach(() => vi.restoreAllMocks());
afterAll(async () => state.cleanup());

async function prepare(kind: "exec" | "plugin" | "system-agent") {
  const databaseOptions = { path: state.statePath("original.sqlite"), env: state.env };
  const original = { ...databaseOptions };
  const redirected = { ...databaseOptions, path: state.statePath("redirected.sqlite") };
  const persistence = { runtimeEpoch: "physical-owner", databaseOptions };
  const managers = {
    exec: new ExecApprovalManager<ExecApprovalRequestPayload>({ persistence }),
    plugin: new ExecApprovalManager<PluginApprovalRequestPayload>({
      persistence,
      approvalKind: "plugin",
    }),
    "system-agent": new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      persistence,
      approvalKind: "system-agent",
    }),
  };
  const manager = managers[kind];
  const record = createExecApprovalRecord<SystemAgentApprovalRequestPayload>(
    {
      command: "echo synthetic owner",
      title: "Synthetic owner",
      description: "Owner custody regression",
      proposalHash: "a".repeat(64),
      allowedDecisions: ["allow-once", "deny"],
      sessionId: "synthetic-session",
    },
    600_000,
  );
  record.approvalReviewerDeviceIds = ["owner-reviewer"];
  const { decision } = await manager.register(record, 600_000);
  const settled = vi.fn();
  void decision.then(settled, () => undefined);
  const pending = expectDefined(
    getOperatorApproval({ id: record.id, databaseOptions: original }),
    "original approval",
  );
  await store.insertOperatorApproval({ approval: pending, databaseOptions: redirected });
  return {
    manager,
    managers,
    record,
    decision,
    settled,
    pending,
    original,
    redirected,
    databaseOptions,
    close: () => Promise.all(Object.values(managers).map((value) => value.drain())),
  };
}

async function retainUncertainty(manager: Pick<ExecApprovalManager, "resolve">, id: string) {
  vi.spyOn(store, "resolveOperatorApproval").mockRejectedValueOnce(
    new SqliteWorkerError("uncertain verdict", "outcome-unknown"),
  );
  vi.spyOn(store, "getOperatorApprovalDetailed").mockRejectedValueOnce(
    new SqliteWorkerError("unavailable readback", "unavailable"),
  );
  await expect(manager.resolve(id, "allow-once")).rejects.toThrow("verdict remains uncertain");
}

it.each(["resolve", "deny", "cancel", "expiry"] as const)(
  "keeps an uncertain %s retry in its still-valid original database",
  async (operation) => {
    const fixture = await prepare("exec");
    const { manager, record, original, redirected, databaseOptions, pending, decision } = fixture;
    try {
      await retainUncertainty(manager, record.id);
      databaseOptions.path = redirected.path;
      if (operation === "resolve") {
        await manager.resolve(record.id, "allow-once");
      } else if (operation === "expiry") {
        vi.spyOn(Date, "now").mockReturnValue(record.expiresAtMs);
        installTestApprovalClock();
        await manager.listPendingRecords();
      } else {
        await manager.forceDenyDetailed(
          record.id,
          operation === "cancel" ? "run-aborted" : "malformed-verdict",
          { kind: "system", id: "fixture" },
          operation === "cancel" ? "cancelled" : "denied",
        );
      }
      expect(
        getOperatorApproval({
          id: record.id,
          nowMs: record.createdAtMs,
          databaseOptions: redirected,
        }),
      ).toEqual(pending);
      expect(
        getOperatorApproval({ id: record.id, nowMs: record.createdAtMs, databaseOptions: original })
          ?.status,
      ).toBe(
        operation === "resolve"
          ? "allowed"
          : operation === "expiry"
            ? "expired"
            : operation === "cancel"
              ? "cancelled"
              : "denied",
      );
      await expect(decision).resolves.toBe(
        operation === "resolve" ? "allow-once" : operation === "deny" ? "deny" : null,
      );
    } finally {
      await fixture.close();
    }
  },
);

it.each(
  (["exec", "plugin", "system-agent"] as const).flatMap((kind) =>
    (["get", "resolve", "transport-resolve", "reconcile"] as const).map((operation) => ({
      kind,
      operation,
    })),
  ),
)(
  "does not settle $kind from a foreign copied verdict during $operation",
  async ({ kind, operation }) => {
    const fixture = await prepare(kind);
    const { manager, managers, record, original, redirected, databaseOptions, pending, settled } =
      fixture;
    try {
      await retainUncertainty(manager, record.id);
      const winner = await store.resolveOperatorApproval({
        id: record.id,
        decision: "allow-once",
        resolver: { kind: "device", id: "copy-reviewer" },
        databaseOptions: redirected,
      });
      expect(winner.outcome).toBe("resolved");
      if (!("record" in winner)) {
        throw new Error("expected copied terminal row");
      }
      databaseOptions.path = redirected.path;
      if (operation === "reconcile") {
        expect(
          await manager.reconcileDurableLookup({ outcome: "found", record: winner.record }),
        ).toMatchObject({ status: "pending" });
      } else {
        const response = await createApprovalInvocation({
          handlers: createApprovalHandlers({
            execApprovalManager: managers.exec,
            pluginApprovalManager: managers.plugin,
            systemAgentApprovalManager: managers["system-agent"],
            databaseOptions,
          }),
          method: operation === "get" ? "approval.get" : "approval.resolve",
          body:
            operation === "get"
              ? { id: record.id }
              : {
                  id: operation === "transport-resolve" ? pending.resolutionRef : record.id,
                  kind,
                  decision: "allow-once",
                },
          client: createClient({ deviceId: "owner-reviewer" }),
        }).invoke();
        expect(response).toMatchObject(
          operation === "get"
            ? { ok: true, result: { approval: { status: "pending" } } }
            : { ok: true, result: { applied: true, approval: { status: "allowed" } } },
        );
      }
      if (operation === "get" || operation === "reconcile") {
        const observer = vi.fn();
        void manager.awaitDecision(record.id)?.then(observer, () => undefined);
        expect(await manager.listPendingRecords()).toContain(record);
        expect(settled).not.toHaveBeenCalled();
        expect(observer).not.toHaveBeenCalled();
        expect(getOperatorApproval({ id: record.id, databaseOptions: original })).toEqual(pending);
      } else {
        expect(getOperatorApproval({ id: record.id, databaseOptions: original })).toMatchObject({
          status: "allowed",
          resolver: { id: "owner-reviewer" },
        });
      }
      expect(getOperatorApproval({ id: record.id, databaseOptions: redirected })).toEqual(
        winner.record,
      );
    } finally {
      await fixture.close();
    }
  },
);

it.each([true, false])(
  "settles a corrupt transport-ref lookup only for an authorized reviewer (%s)",
  async (authorized) => {
    const fixture = await prepare("exec");
    const { manager, managers, record, decision, settled, pending, original } = fixture;
    corruptDurableApprovalPresentation(original, record.id);
    const lookup = vi.spyOn(store, "getOperatorApprovalDetailed");
    try {
      const response = await createApprovalInvocation({
        handlers: createApprovalHandlers({
          execApprovalManager: managers.exec,
          pluginApprovalManager: managers.plugin,
          databaseOptions: original,
        }),
        method: "approval.resolve",
        body: { id: pending.resolutionRef, kind: "exec", decision: "allow-once" },
        client: createClient({ deviceId: authorized ? "owner-reviewer" : "unrelated-reviewer" }),
      }).invoke();
      expect(response).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
      });
      if (authorized) {
        await expect(decision).resolves.toBe("deny");
        expect(manager.getLiveSnapshot(record.id)).toMatchObject({
          status: "denied",
          terminalReason: "storage-corrupt",
        });
      } else {
        expect(lookup).not.toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();
        expect(record.resolvedAtMs).toBeUndefined();
        expect(manager.getLiveSnapshot(record.id)).toBe(record);
      }
    } finally {
      await fixture.close();
    }
  },
);
