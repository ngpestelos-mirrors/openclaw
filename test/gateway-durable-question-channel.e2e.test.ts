import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { QuestionGetResult, QuestionRecord } from "../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { linkUserChannelIdentity } from "../src/state/user-channel-identities.js";
import {
  changeCanonicalUserChannelIdentity,
  publishCanonicalUserChannelPolicy,
} from "../src/state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../src/state/user-profiles.js";
import { withEnvAsync } from "../src/test-utils/env.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { createDurableQuestionGateway } from "./helpers/durable-question-gateway.js";
import { createDeferred, withinTest } from "./helpers/promise.js";

it.each(["allow", "unlink"] as const)(
  "restores native channel question custody with %s original sender authority",
  { timeout: 180_000 },
  async (authority, { signal }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "openclaw-question-channel-"));
    const deliveries: string[] = [];
    const recipients: string[] = [];
    const sink = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        createServer((request, response) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!isRecord(value) || typeof value.text !== "string")
              throw new Error("Invalid platform delivery");
            deliveries.push(value.text);
            recipients.push(String(value.to));
            response.writeHead(200).end();
          })().catch((error: unknown) => response.writeHead(500).end(String(error)));
        }),
    });
    const readyPath = path.join(directory, "ready.json");
    const transportToken = randomUUID();
    await copyFile(
      new URL("./fixtures/durable-question-channel.mjs", import.meta.url),
      path.join(directory, "index.mjs"),
    );
    await writeFile(
      path.join(directory, "openclaw.plugin.json"),
      JSON.stringify({
        id: "durable-proof",
        channels: ["durable-proof"],
        channelConfigs: {
          "durable-proof": { schema: { type: "object", additionalProperties: true } },
        },
        configSchema: {
          type: "object",
          properties: {
            sinkUrl: { type: "string" },
            readyPath: { type: "string" },
            transportToken: { type: "string" },
          },
          additionalProperties: false,
        },
      }),
    );
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "durable-proof",
        type: "module",
        openclaw: { extensions: ["./index.mjs"] },
      }),
    );
    const gateway: NonNullable<OpenClawConfig["gateway"]> = {
      roles: {
        default: "member",
        definitions: {
          admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
          member: {
            scopes: ["operator.read", "operator.write"],
            agents: "*",
            sessions: { others: "view" },
          },
        },
      },
    };
    const fixture = await createDurableQuestionGateway(signal, {
      config: {
        plugins: {
          allow: ["durable-proof"],
          load: { paths: [directory] },
          entries: {
            "durable-proof": {
              enabled: true,
              config: { sinkUrl: `http://127.0.0.1:${sink.claim.port}`, readyPath, transportToken },
            },
          },
        },
        channels: { "durable-proof": { accounts: { team: { allowFrom: ["sender"] } } } },
        gateway,
      },
    });
    let client: Awaited<ReturnType<typeof fixture.connect>> | undefined;
    const requested = createDeferred<QuestionRecord>();
    let profileId = "";
    try {
      await withEnvAsync(fixture.instance.state.envVars, async () => {
        const profile = ensureProfileForEmail("channel-proof@example.test");
        profileId = profile.id;
        setUserProfileRole(profile.id, "admin");
        linkUserChannelIdentity(profile.id, {
          channelId: "durable-proof",
          accountId: "team",
          senderId: "sender",
        });
        await publishCanonicalUserChannelPolicy(gateway);
      });
      await fixture.instance.startGateway();
      client = await fixture.connect(({ event, payload }) => {
        if (event === "question.requested" && isRecord(payload))
          requested.resolve(payload as QuestionRecord);
      });
      let port = 0;
      await vi.waitFor(
        async () => {
          const ready: unknown = JSON.parse(await readFile(readyPath, "utf8"));
          if (!isRecord(ready) || typeof ready.port !== "number")
            throw new Error("Channel not ready");
          port = ready.port;
        },
        { timeout: 30_000 },
      );
      const ingress = fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { authorization: `Bearer ${transportToken}` },
        body: JSON.stringify({
          text: "DURABLE_ASK_PROOF: ask which environment and continue after the answer",
        }),
        signal,
      });
      const question = await withinTest(Promise.race([requested.promise, fixture.failed]), signal);
      expect(question.sessionKey).toEqual(expect.any(String));
      expect((await withinTest(ingress, signal)).status).toBe(200);
      await vi.waitFor(() => expect(deliveries.join("\n")).toContain("Which environment?"), {
        timeout: 30_000,
      });
      await client.stopAndWait();
      client = undefined;
      await fixture.instance.stopGateway();
      if (authority === "unlink") {
        await withEnvAsync(fixture.instance.state.envVars, () =>
          changeCanonicalUserChannelIdentity("unlink", profileId, {
            channelId: "durable-proof",
            accountId: "team",
            senderId: "sender",
          }),
        );
      }
      await fixture.instance.startGateway();
      let resolutionEvents = 0;
      const terminalReceiptPublished = createDeferred();
      client = await fixture.connect(({ event, payload }) => {
        if (event === "question.resolved" && isRecord(payload) && payload.id === question.id) {
          resolutionEvents += 1;
          if (resolutionEvents === 2) terminalReceiptPublished.resolve();
        }
      });
      expect(
        (await client.request<QuestionGetResult>("question.get", { id: question.id })).question,
      ).toEqual(question);
      await client.request("question.resolve", {
        id: question.id,
        answers: { answers: { choice: ["Staging"] } },
        resolutionId: "channel-answer",
      });
      if (authority === "unlink") {
        await vi.waitFor(
          async () => {
            const blocked = await client!.request<QuestionGetResult>("question.get", {
              id: question.id,
              includeContinuation: true,
            });
            expect(blocked.continuation).toMatchObject({ status: "blocked" });
            expect(blocked.continuation?.reason).toContain("new user turn");
          },
          { timeout: 30_000 },
        );
        await withinTest(terminalReceiptPublished.promise, signal);
        expect(deliveries).not.toContain("DURABLE_CONTINUATION_USED_STAGING");
        return;
      }
      await withinTest(Promise.race([fixture.continued, fixture.failed]), signal);
      await vi.waitFor(() => expect(deliveries).toContain("DURABLE_CONTINUATION_USED_STAGING"), {
        timeout: 30_000,
      });
      await vi.waitFor(
        async () => {
          const receipt = await client!.request<QuestionGetResult>("question.get", {
            id: question.id,
            includeContinuation: true,
          });
          expect(receipt.continuation).toMatchObject({ status: "settled" });
        },
        { timeout: 30_000 },
      );
      expect(recipients[deliveries.indexOf("DURABLE_CONTINUATION_USED_STAGING")]).toBe(
        recipients[deliveries.findIndex((text) => text.includes("Which environment?"))],
      );
    } finally {
      await client?.stopAndWait();
      await fixture.cleanup();
      sink.listener.closeAllConnections();
      await sink.releaseListener();
      await sink.claim.release();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
