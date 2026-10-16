import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  loadSessionEntry,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import * as preparation from "../session-sharing-preparation.js";
import * as artifactReads from "../session-transcript-readers.js";
import { artifactsHandlers } from "./artifacts.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { fetchSessionFileDownload } from "./sessions-files.test-support.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

it("admits session-only artifact readers with current session visibility and prepared facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:prepared-artifacts",
      sessionId: "prepared-artifacts",
    };
    const entry = {
      sessionId: scope.sessionId,
      updatedAt: 1,
      visibility: "shared" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
    };
    await replaceSessionEntry(scope, entry);
    const data = Buffer.alloc(912, "x").toString("base64");
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      {
        type: "message",
        id: "artifact",
        parentId: null,
        message: { role: "assistant", content: [{ type: "file", title: "result.txt", data }] },
      },
    ]);
    await waitForSessionTranscriptProjection(scope);
    expect(loadSessionEntry(scope)?.visibility).toBe("shared");
    const context = await createHistoryReadContext();
    let client = identifiedClient("viewer");
    client.connect.scopes = ["operator.sessions.read"];
    const controller = new AbortController();
    client.connId = "session-artifact-reader";
    client.connectionSignal = controller.signal;
    using _ = { [Symbol.dispose]: () => controller.abort() };
    const request = async (
      method: "artifacts.list" | "artifacts.get" | "artifacts.download",
      params: Record<string, unknown> = {},
      throughDispatcher = true,
    ) => {
      const respond = vi.fn<RespondFn>();
      const options = {
        context,
        client,
        req: {
          type: "req" as const,
          id: "prepared-artifacts",
          method,
          params: { sessionKey: scope.sessionKey, ...params },
        },
        extraHandlers: artifactsHandlers,
        isWebchatConnect: () => false,
        respond,
      };
      if (throughDispatcher) {
        await handleGatewayRequest(options);
      } else {
        await artifactsHandlers[method]!({ ...options, params: options.req.params });
      }
      return respond.mock.calls[0]!;
    };
    const listed = await request("artifacts.list");
    expect(listed[0]).toBe(true);
    const payload = listed[1] as { artifacts: { id: string; sizeBytes: number }[] };
    expect(payload.artifacts).toHaveLength(1);
    expect(payload.artifacts[0]?.sizeBytes).toBe(912);
    const artifactId = payload.artifacts[0]!.id;
    const granted = await request("artifacts.download", { artifactId, transport: "http" });
    expect(granted[0]).toBe(true);
    const download = granted[1] as { url: string };
    expect(download.url).toMatch(/^\/api\/artifacts\/download\//);
    const fetched = await fetchSessionFileDownload(client, download.url);
    expect(fetched.response.statusCode).toBe(200);
    expect(fetched.body).toEqual(new Uint8Array(Buffer.from(data, "base64")));
    for (const method of ["artifacts.get", "artifacts.download"] as const) {
      const missing = await request(method, { artifactId: "artifact_missing" });
      expect(missing[0]).toBe(false);
      expect(missing[2]).toMatchObject({ details: { type: "artifact_not_found" } });
      const unknown = await request(method, {
        sessionKey: "agent:main:unknown-artifacts",
        artifactId,
      });
      expect(unknown[0]).toBe(false);
      expect(unknown[1]).toBeUndefined();
    }
    const otherScope = {
      agentId: "main",
      sessionKey: "agent:main:other-artifacts",
      sessionId: "other-artifacts",
    };
    await replaceSessionEntry(otherScope, { ...entry, sessionId: otherScope.sessionId });
    for (const method of ["artifacts.get", "artifacts.download"] as const) {
      const unrelated = await request(method, { sessionKey: otherScope.sessionKey, artifactId });
      expect(unrelated[0]).toBe(false);
      expect(unrelated[2]).toMatchObject({ details: { type: "artifact_not_found" } });
    }
    const prepare = vi.spyOn(preparation, "prepareSessionMutationFacts");
    const samples: Record<string, number[]> = {
      "artifacts.list": [],
      "artifacts.get": [],
      "artifacts.download": [],
    };
    const rounds = process.env.OPENCLAW_DB_WORKER_BENCH === "1" ? 100 : 1;
    for (let round = 0; round < rounds; round++) {
      for (const method of ["artifacts.list", "artifacts.get", "artifacts.download"] as const) {
        const start = performance.now();
        const result = await request(
          method,
          method === "artifacts.list" ? {} : { artifactId },
          false,
        );
        samples[method]!.push(performance.now() - start);
        expect(result[0]).toBe(true);
        if (method !== "artifacts.list") {
          expect(result[1]).toMatchObject({ artifact: { id: artifactId, sizeBytes: 912 } });
        }
        if (method === "artifacts.download") {
          expect(result[1]).toMatchObject({ data, encoding: "base64" });
        }
      }
    }
    if (rounds > 1) {
      for (const [method, values] of Object.entries(samples)) {
        values.sort((a, b) => a - b);
        console.log(
          JSON.stringify({
            method,
            samples: values.length,
            payloadBytes: 912,
            medianMs: values[Math.floor(values.length / 2)],
            p99Ms: values[Math.ceil(values.length * 0.99) - 1],
          }),
        );
      }
    }
    expect(prepare).not.toHaveBeenCalled();
    const readArtifacts = artifactReads.readSessionArtifacts;
    vi.spyOn(artifactReads, "readSessionArtifacts").mockImplementationOnce(async (...args) => {
      const result = await readArtifacts(...args);
      await replaceSessionEntry(scope, { ...entry, visibility: "draft", updatedAt: 2 });
      return result;
    });
    const revoked = await request("artifacts.download", { artifactId });
    expect(revoked[0]).toBe(false);
    expect(revoked[2]).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    const revokedDownload = await fetchSessionFileDownload(client, download.url);
    expect(revokedDownload.response.statusCode).toBe(404);
    expect(revokedDownload.body).toEqual(new Uint8Array(Buffer.from("Not Found")));
    for (const method of ["artifacts.list", "artifacts.get", "artifacts.download"] as const) {
      const result = await request(method, method === "artifacts.list" ? {} : { artifactId });
      expect(result[0]).toBe(false);
      expect(result[1]).toBeUndefined();
      expect(result[2]).toMatchObject({ code: "INVALID_REQUEST" });
    }
    client = identifiedClient("owner");
    client.connect.scopes = ["operator.sessions.read"];
    for (const method of ["artifacts.list", "artifacts.get", "artifacts.download"] as const) {
      const owned = await request(method, method === "artifacts.list" ? {} : { artifactId });
      expect(owned[0]).toBe(true);
    }
  });
});
