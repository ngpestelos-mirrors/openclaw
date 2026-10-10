import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createQuestionRecovery } from "../question-recovery.js";
import {
  adminRequestClient,
  callQuestionRpc,
  installQuestionTestHooks,
  manager,
} from "./question.test-support.js";

let waitForRecovery: () => Promise<void> = async () => {};
installQuestionTestHooks({ waitForRecovery: () => waitForRecovery() });

function restore(id: string) {
  return manager.request({
    id,
    questions: [
      {
        questionId: "choice",
        header: "Choice",
        question: "Which?",
        options: [],
        multiSelect: false,
        isOther: true,
        isSecret: false,
      },
    ],
    timeoutMs: 1_000,
  });
}

function recovery(run: () => Promise<void>) {
  const scheduler = createTestGatewayScheduler("fake-timers");
  const recover = vi.fn(run);
  const owner = createQuestionRecovery({
    scheduler,
    discover: async () => ({
      scopes: [
        { agentId: "main", sessionKey: "agent:main:main", storePath: "/synthetic/original.sqlite" },
      ],
    }),
    recover,
    assertCurrent: () => {},
    track: (work) => Promise.resolve().then(work),
    warn: () => {},
  });
  waitForRecovery = owner.waitForRecovery;
  return {
    owner,
    recover,
    stop: async () => {
      await owner.stop();
      await scheduler.stop();
    },
  };
}

it("joins shared held recovery before get, resolve, and waitAnswer consume the restored question", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const runtime = recovery(async () => {
    entered.resolve();
    await release.promise;
    restore("restored");
  });
  const pass = runtime.owner.recover();
  const get = callQuestionRpc("question.get", { id: "restored" });
  const wait = callQuestionRpc("question.waitAnswer", { id: "restored" });
  const resolve = callQuestionRpc("question.resolve", {
    id: "restored",
    answers: { answers: { choice: ["A"] } },
  });
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      Promise.all([get, wait, resolve]),
      "RPCs must await shared recovery",
    );
    expect(manager.observe("restored")).toBeNull();
    release.resolve();
    const results = await Promise.all([get, wait, resolve]);
    expect(results[0]).toMatchObject([true, { question: { id: "restored" } }, undefined]);
    expect(results[1]).toMatchObject([
      true,
      { status: "answered", answers: { answers: { choice: ["A"] } } },
      undefined,
    ]);
    expect(results[2]?.[0]).toBe(true);
    expect(runtime.recover).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await pass;
    await runtime.stop();
  }
});

it("serves an existing healthy observation without waiting for unrelated held recovery", async () => {
  const release = createDeferred();
  const runtime = recovery(async () => {
    await release.promise;
  });
  const pass = runtime.owner.recover();
  restore("healthy");
  try {
    expect(await callQuestionRpc("question.get", { id: "healthy" })).toMatchObject([
      true,
      { question: { id: "healthy" } },
      undefined,
    ]);
  } finally {
    release.resolve();
    await pass;
    await runtime.stop();
  }
});

it("awaits recovery before returning the complete list alongside a healthy existing observation", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const runtime = recovery(async () => {
    entered.resolve();
    await release.promise;
    restore("recovered-sibling");
  });
  restore("healthy-sibling");
  const list = callQuestionRpc("question.list", {});
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      list,
      "List must await recovery for a complete cohort",
    );
    release.resolve();
    expect(await list).toMatchObject([
      true,
      {
        questions: expect.arrayContaining([
          expect.objectContaining({ id: "healthy-sibling" }),
          expect.objectContaining({ id: "recovered-sibling" }),
        ]),
      },
      undefined,
    ]);
  } finally {
    release.resolve();
    await runtime.stop();
  }
});

it("reports unavailable recovery instead of falsely reporting missing custody", async () => {
  const runtime = recovery(async () => {
    throw new Error("native store temporarily unavailable");
  });
  try {
    await runtime.owner.recover();
    expect(await callQuestionRpc("question.get", { id: "unrestored" })).toMatchObject([
      false,
      undefined,
      { code: "UNAVAILABLE" },
    ]);
  } finally {
    await runtime.stop();
  }
});

it("rechecks requester authority after recovery and refuses a revoked answer without effects", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const runtime = recovery(async () => {
    entered.resolve();
    await release.promise;
    restore("revoked-answer");
  });
  let current = true;
  const answer = callQuestionRpc(
    "question.resolve",
    { id: "revoked-answer", answers: { answers: { choice: ["A"] } } },
    {
      client: adminRequestClient,
      hasCurrentClientAuthority: () => current,
    },
  );
  const refused = expect(answer).rejects.toThrow("authority changed");
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      answer,
      "Answer must await recovery before authorization is revoked",
    );
    current = false;
    release.resolve();
    await refused;
    expect(manager.get("revoked-answer")?.status).toBe("pending");
  } finally {
    release.resolve();
    await runtime.stop();
  }
});

it("cancels one waiting request without cancelling the shared recovery owner", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const runtime = recovery(async () => {
    entered.resolve();
    await release.promise;
    restore("after-disconnect");
  });
  const connection = new AbortController();
  const client = { ...adminRequestClient, connectionSignal: connection.signal };
  const request = callQuestionRpc("question.get", { id: "after-disconnect" }, { client });
  const refused = expect(request).rejects.toThrow("disconnected");
  try {
    await awaitGateBeforeSettlement(entered.promise, request, "Request must join held recovery");
    connection.abort(new Error("disconnected"));
    await refused;
    expect(runtime.recover).toHaveBeenCalledTimes(1);
    release.resolve();
    await runtime.owner.waitForRecovery();
    expect(await callQuestionRpc("question.get", { id: "after-disconnect" })).toMatchObject([
      true,
      { question: { id: "after-disconnect" } },
      undefined,
    ]);
  } finally {
    release.resolve();
    await runtime.stop();
  }
});
