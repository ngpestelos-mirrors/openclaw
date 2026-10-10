import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionQuestionCustodyRetiredError } from "../config/sessions/session-questions-custody-error.js";
import type { DurableQuestion } from "../config/sessions/session-questions.types.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import type { InternalAgentTurnDispatchOptions } from "./agent-turn/internal-facade.types.js";
import { dispatchQuestionContinuation } from "./question-continuation.js";
import type { GatewayInstanceRuntime } from "./server-instance-runtime.types.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

const state = vi.hoisted(() => ({
  operate: vi.fn(),
  readCustody: vi.fn(),
  restore: vi.fn(),
  prepareChannel: vi.fn(),
  captureChannel: vi.fn(),
}));
vi.mock("../config/sessions/session-questions.js", () => ({
  executeSessionQuestionOperation: state.operate,
  readSessionQuestionCustody: state.readCustody,
}));
vi.mock("../infra/agent-events.js", () => ({ getAgentEventLifecycleGeneration: () => "epoch" }));
vi.mock("./operator-run-recovery.js", () => ({
  restoreGatewayQuestionOperatorRecovery: state.restore,
}));
vi.mock("./operator-run-authority.js", () => ({
  captureChannelOperatorRunAuthority: state.captureChannel,
}));
vi.mock("./channel-operator-authority.js", () => ({
  prepareChannelOperatorAdmin: state.prepareChannel,
}));
vi.mock("./server-plugin-runtime-client.js", () => ({
  createSyntheticPluginRuntimeClient: (source: unknown) => source,
}));

function question(): DurableQuestion {
  return {
    record: {
      id: "ask_fixture",
      agentId: "main",
      sessionKey: "agent:main:test",
      status: "answered",
      createdAtMs: 1,
      expiresAtMs: 2,
      questions: [],
      answers: { answers: {} },
    },
    sessionKey: "agent:main:test",
    sessionId: "session",
    lifecycleRevision: "revision",
    sessionBinding: {
      agentId: "main",
      sessionKey: "agent:main:test",
      storePath: "/tmp/fixture.db",
      databasePath: "/tmp/fixture.db",
      databaseIdentity: { identity: "fixture" },
      sessionId: "session",
      lifecycleRevision: "revision",
    },
    provenance: {
      issuer: "operator",
      sourceRunId: "original",
      recoverySource: {
        version: 1,
        agentId: "main",
        sessionKey: "agent:main:test",
        sessionId: "session",
        lifecycleRevision: "revision",
        sourceRunId: "original",
        snapshot: {
          profileId: "original-person",
          scopes: ["operator.write"],
          assignedRole: null,
          githubLogin: null,
          grant: null,
          aliasBindingIds: [],
          authPolicy: {
            generation: "",
            grantGeneration: "generation",
            role: "operator",
            authMethod: "token",
          },
          controlUiAdmin: false,
          localOperator: false,
          sourceIngress: "internal",
        },
      },
    },
    continuation: { status: "owed" },
  };
}

function fixture(saved = question()) {
  state.readCustody.mockImplementation((binding, id, assertCurrent) => {
    expect(binding).toBe(saved.sessionBinding);
    return state.operate({ ...binding, assertCurrent }, { kind: "get", id });
  });
  const authority = {
    profileId: "original-person",
    scopes: ["operator.write"],
    assertCurrent: vi.fn(),
  };
  const dispatch = vi.fn(
    async (_request: AgentRunRequest, _options: InternalAgentTurnDispatchOptions) => ({}),
  );
  const facade = vi.fn(async (_principal: { client: unknown }) => ({ dispatch }));
  state.operate.mockImplementation(async (_scope, operation) =>
    operation.kind === "get"
      ? saved
      : {
          ...saved,
          continuation: {
            status:
              operation.kind === "finish"
                ? operation.interrupted
                  ? "interrupted"
                  : "settled"
                : "claimed",
            runId: operation.runId,
            gatewayEpoch: operation.gatewayEpoch ?? "epoch",
          },
        },
  );
  state.restore.mockResolvedValue({ authority, release: vi.fn() });
  return {
    saved,
    authority,
    dispatch,
    facade,
    params: {
      question: saved,
      scope: saved.sessionBinding,
      context: { getRuntimeConfig: () => ({}) } as GatewayRequestContext,
      runtime: {
        isAvailable: () => true,
        createAgentTurnFacade: facade,
      } as unknown as GatewayInstanceRuntime,
      assertCurrent: vi.fn(),
    },
  };
}

describe("durable question continuation custody", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not dispatch under a system principal when original authority cannot be restored", async () => {
    const f = fixture();
    state.restore.mockResolvedValue(undefined);
    await expect(dispatchQuestionContinuation(f.params)).rejects.toThrow(
      "original caller authority",
    );
    expect(f.facade).not.toHaveBeenCalled();
    expect(state.operate.mock.calls.some(([, op]) => op.kind === "claim")).toBe(false);
  });

  it("rejects replaced durable source custody before authority restoration", async () => {
    const f = fixture();
    state.operate.mockResolvedValue({ ...f.saved, lifecycleRevision: "replacement" });
    await expect(dispatchQuestionContinuation(f.params)).rejects.toThrow("custody changed");
    expect(state.restore).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("rejects a canonical claim receipt owned by another run before continuation execution", async () => {
    const f = fixture();
    state.operate.mockImplementation(async (_scope, operation) =>
      operation.kind === "get"
        ? f.saved
        : {
            ...f.saved,
            continuation: { status: "claimed", runId: "another-run", gatewayEpoch: "epoch" },
          },
    );
    f.dispatch.mockImplementation(async (request, options) => {
      expect(request.expectedExistingSessionLifecycleRevision).toBe("revision");
      await options.commitAdmission!({
        runId: request.idempotencyKey,
        sessionId: "session",
        sessionKey: "agent:main:test",
        storePath: "/tmp/fixture.db",
        lifecycleGeneration: "epoch",
        assertCurrent: () => {},
      });
      throw new Error("execution must never be reached");
    });
    await expect(dispatchQuestionContinuation(f.params)).rejects.toThrow("claim was not admitted");
    expect(state.operate.mock.calls.some(([, operation]) => operation.kind === "finish")).toBe(
      false,
    );
  });

  it("records an interrupted claim when reset fences the admitted turn after worker commit", async () => {
    const f = fixture();
    f.dispatch.mockImplementation(async (_request, options) => {
      await options.commitAdmission!({
        runId: _request.idempotencyKey,
        sessionId: "session",
        sessionKey: "agent:main:test",
        storePath: "/tmp/fixture.db",
        lifecycleGeneration: "epoch",
        assertCurrent: () => {},
      });
      throw new Error("reset retired the admitted session");
    });
    await expect(dispatchQuestionContinuation(f.params)).rejects.toThrow("reset retired");
    expect(state.operate.mock.calls.at(-1)?.[1]).toMatchObject({
      kind: "finish",
      interrupted: true,
    });
    expect(state.restore).toHaveBeenCalledWith(
      expect.objectContaining({ expectedQuestion: f.saved }),
    );
    expect(f.facade.mock.calls[0][0].client).toMatchObject({
      operatorRoleActor: { kind: "operator", profileId: "original-person" },
    });
  });

  it.each(["own", "another", "revoked"] as const)(
    "reconciles an uncertain claim acknowledgement for the %s run without executing",
    async (owner) => {
      const f = fixture();
      let committed: DurableQuestion | undefined;
      const executed = vi.fn();
      state.operate.mockImplementation(async (_scope, operation) => {
        if (operation.kind === "get") return committed ?? f.saved;
        if (operation.kind === "claim") {
          committed = {
            ...f.saved,
            continuation: {
              status: "claimed",
              runId: owner !== "another" ? operation.runId : "another-run",
              gatewayEpoch: operation.gatewayEpoch,
            },
          };
          if (owner === "revoked") throw new Error("authority revoked after commit");
          throw new SqliteWorkerError("worker acknowledgement lost", "outcome-unknown");
        }
        return committed;
      });
      f.dispatch.mockImplementation(async (request, options) => {
        await options.commitAdmission!({
          runId: request.idempotencyKey,
          sessionId: "session",
          sessionKey: "agent:main:test",
          storePath: "/tmp/fixture.db",
          lifecycleGeneration: "epoch",
          assertCurrent() {},
        });
        executed();
        return {};
      });
      await expect(dispatchQuestionContinuation(f.params)).rejects.toThrow(
        owner === "revoked" ? "revoked after commit" : "acknowledgement lost",
      );
      expect(executed).not.toHaveBeenCalled();
      expect(
        state.operate.mock.calls.find(([, operation]) => operation.kind === "claim")?.[1],
      ).toMatchObject({ expectedQuestion: f.saved });
      const finishes = state.operate.mock.calls.filter(
        ([, operation]) => operation.kind === "finish",
      );
      expect(finishes).toHaveLength(owner !== "another" ? 1 : 0);
      if (owner !== "another")
        expect(finishes[0][1]).toMatchObject({ interrupted: true, expectedQuestion: f.saved });
    },
  );

  it("retains the validated channel recovery reference for subsequent durable questions", async () => {
    const f = fixture();
    const reference = { version: 1, id: "validated-channel" } as const;
    f.saved.provenance = {
      issuer: "channel",
      sourceRunId: "original",
      channelAuthorizationReference: reference,
    };
    state.prepareChannel.mockResolvedValue({
      operatorProfile: { profileId: "original-person" },
      recoveryReference: reference,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    state.captureChannel.mockReturnValue(f.authority);
    await dispatchQuestionContinuation(f.params);
    expect(state.captureChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channelRecoveryReference: reference,
      }),
    );
  });

  it("does not clean up a replacement question after captured custody retires", async () => {
    const f = fixture();
    state.operate.mockRejectedValue(
      new SessionQuestionCustodyRetiredError("Question custody retired"),
    );
    await expect(dispatchQuestionContinuation(f.params)).rejects.toThrow("custody retired");
    expect(state.operate.mock.calls.map(([, operation]) => operation.kind)).toEqual(["get"]);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each(["before commit", "after commit", "repair ACK"] as const)(
    "repairs a completed turn receipt lost %s without dispatching or interrupting again",
    async (fault) => {
      const f = fixture();
      let canonical = f.saved;
      let finishAttempts = 0;
      state.operate.mockImplementation(async (_scope, operation) => {
        if (operation.kind === "get") return canonical;
        if (operation.kind === "claim") {
          canonical = {
            ...f.saved,
            continuation: {
              status: "claimed",
              runId: operation.runId,
              gatewayEpoch: operation.gatewayEpoch,
            },
          };
          return canonical;
        }
        if (operation.kind === "finish") {
          expect(operation.interrupted).toBe(false);
          finishAttempts++;
          if (finishAttempts === 1 && fault !== "after commit") {
            throw new Error("Receipt write unavailable");
          }
          canonical = {
            ...canonical,
            continuation: { ...canonical.continuation, status: "settled" },
          };
          if (finishAttempts === 1 || fault === "repair ACK") {
            throw new SqliteWorkerError("Receipt ACK lost", "outcome-unknown");
          }
          return canonical;
        }
        throw new Error("Completed execution must not be blocked or interrupted.");
      });
      f.dispatch.mockImplementation(async (request, options) => {
        await options.commitAdmission!({
          runId: request.idempotencyKey,
          sessionId: "session",
          sessionKey: "agent:main:test",
          storePath: "/tmp/fixture.db",
          lifecycleGeneration: "epoch",
          assertCurrent() {},
        });
        return {};
      });
      await expect(dispatchQuestionContinuation(f.params)).resolves.toMatchObject({
        status: "settled",
      });
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(finishAttempts).toBe(fault === "after commit" ? 1 : 2);
      expect(canonical.continuation.status).toBe("settled");
      expect(
        state.operate.mock.calls
          .filter(([, operation]) => operation.kind === "finish")
          .every(([, operation]) => operation.interrupted === false),
      ).toBe(true);
    },
  );
});
