import { once } from "node:events";
import { access } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { QuestionGetResult, QuestionRecord } from "../packages/gateway-protocol/src/index.js";
import { createDurableQuestionGateway } from "./helpers/durable-question-gateway.js";
import { createDeferred, withinTest } from "./helpers/promise.js";

it(
  "commits a busy-session answer before ACK and delivers its new turn after an immediate Gateway crash",
  { timeout: 180_000 },
  async ({ signal }) => {
    const fixture = await createDurableQuestionGateway(signal);
    let client: Awaited<ReturnType<typeof fixture.connect>> | undefined;
    const requested = createDeferred<QuestionRecord>();
    try {
      await fixture.instance.startGateway();
      client = await fixture.connect(({ event, payload }) => {
        if (event === "question.requested" && isRecord(payload)) {
          requested.resolve(payload as QuestionRecord);
        }
      });
      const sessionKey = "agent:main:durable-proof";
      await client.request("sessions.create", {
        key: sessionKey,
        agentId: "main",
        model: fixture.model.modelRef,
        permissionMode: "full",
        cwd: fixture.instance.state.workspaceDir,
      });
      const asking = await client.request<{ runId: string }>(
        "chat.send",
        {
          sessionKey,
          message: "DURABLE_ASK_PROOF: Ask which environment, then continue only after the answer.",
          idempotencyKey: "original-asking-turn",
          deliver: false,
        },
        { expectFinal: false },
      );
      const question = await withinTest(Promise.race([requested.promise, fixture.failed]), signal);
      expect(question.status).toBe("pending");
      expect(
        await client.request("agent.wait", { runId: asking.runId, timeoutMs: 30_000 }),
      ).toMatchObject({ status: "ok" });
      await expect(
        access(
          path.join(fixture.instance.state.workspaceDir, "durable-question-side-effect-started"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await client.request<QuestionGetResult>("question.get", { id: question.id })).toEqual({
        question,
      });
      await client.stopAndWait();
      client = undefined;
      await fixture.instance.stopGateway();
      await fixture.instance.startGateway();
      client = await fixture.connect();
      const restored = await client.request<QuestionGetResult>("question.get", {
        id: question.id,
        includeContinuation: true,
      });
      expect(restored.question).toEqual(question);
      expect(restored.continuation).toMatchObject({ questionId: question.id, status: "pending" });
      await client.request(
        "chat.send",
        {
          sessionKey,
          message: "DURABLE_BUSY_PROOF: keep this unrelated foreground turn busy.",
          idempotencyKey: "unrelated-busy-turn",
          deliver: false,
        },
        { expectFinal: false },
      );
      await withinTest(Promise.race([fixture.busyStarted, fixture.failed]), signal);
      const answer = { answers: { choice: ["Staging"] } };
      expect(
        await client.request("question.resolve", {
          id: question.id,
          answers: answer,
          resolutionId: "durable-proof-answer",
        }),
      ).toEqual({ status: "answered", answers: answer });
      // The provider is still held: this ACK cannot depend on native execution.
      expect(fixture.continuationCount).toBe(0);
      const child = fixture.instance.child;
      if (!child) {
        throw new Error("Expected the original Gateway process at the ACK boundary");
      }
      const crashed = once(child, "close");
      expect(child.kill("SIGKILL")).toBe(true);
      await withinTest(crashed, signal);
      await client.stopAndWait();
      client = undefined;
      await fixture.instance.stopGateway();
      fixture.releaseBusy();
      await fixture.instance.startGateway();
      client = await fixture.connect();
      await withinTest(Promise.race([fixture.continued, fixture.failed]), signal);
      expect(fixture.continuationCount).toBe(1);
      const current = await client.request<QuestionGetResult>("question.get", {
        id: question.id,
        includeContinuation: true,
      });
      expect(current.question.answers).toEqual(answer);
      const runId = current.continuation?.runId;
      expect(runId).toEqual(expect.any(String));
      expect(runId).not.toBe(asking.runId);
      expect(await client.request("agent.wait", { runId, timeoutMs: 30_000 })).toMatchObject({
        status: "ok",
      });
      await expect(
        access(
          path.join(fixture.instance.state.workspaceDir, "durable-question-side-effect-started"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const oldShape = await client.request<QuestionGetResult>("question.get", { id: question.id });
      expect(Object.keys(oldShape)).toEqual(["question"]);
      expect(
        await client.request("question.resolve", {
          id: question.id,
          answers: { answers: { choice: ["Production"] } },
          resolutionId: "lost-ack-retry",
        }),
      ).toEqual({ status: "answered", answers: answer });
    } finally {
      try {
        await client?.stopAndWait();
      } finally {
        await fixture.cleanup();
      }
    }
  },
);
