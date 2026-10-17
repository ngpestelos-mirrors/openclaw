import { describe, expect, it, vi } from "vitest";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { ProviderAuthResult } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";
import * as auth from "./users-auth-connect.test-support.js";

auth.setupModelAccountConnectTest();

describe("users model-account connection lifecycle", () => {
  it.each(["direct", "shared-secret", "ingress"] as const)(
    "uses the catalog and exact sensitive step for a %s caller without consuming a rejected answer",
    async (caller) => {
      if (caller === "shared-secret") {
        auth.self.internal = { operatorRoleActor: { kind: "system" } };
      }
      const grant = new AbortController();
      if (caller === "ingress") {
        const principal = createRemoteControlUiIngressTestContext({
          principal: { kind: "person", profileId: "profile-1" },
          signal: grant.signal,
        }).resolvePrincipal();
        auth.clients.delete(auth.self);
        auth.self.connId = "";
        auth.self.internal = {
          remoteIngressPrincipal: principal,
          operatorRoleActor: principal.operatorRoleActor,
        };
      }
      await auth.expectReply(auth.rpc("users.authConnect.catalog", { profileId: "profile-1" }), {
        providers: [
          { id: "openai", label: "OpenAI", methods: [{ id: "oauth", label: "Browser sign-in" }] },
        ],
      });
      const flow = await auth.startFlow();
      const pending = await auth.status(flow);
      const invalid = await auth.flowRpc("answer", flow, {
        stepId: pending.step.id,
        value: "secret-invalid",
      });
      expect(invalid).toHaveBeenCalledWith(true, {
        status: "pending",
        step: pending.step,
        error: expect.any(String),
      });
      expect(JSON.stringify(invalid.mock.calls)).not.toContain("secret-invalid");
      expect(auth.registerSecretValueForRedaction).toHaveBeenCalledWith("secret-invalid");
      expect(auth.exchange).not.toHaveBeenCalled();
      await auth.expectReply(
        auth.flowRpc("answer", flow, { stepId: "stale", value: "synthetic-code" }),
        {
          status: "pending",
          step: pending.step,
          error: expect.any(String),
        },
      );
      await auth.complete(flow);
      const result = await auth.terminal(flow, "connected");
      expect(result).toEqual({
        status: "connected",
        authProfileId: "personal:profile-1:account-1",
        links: [
          { provider: "openai", authProfileId: "personal:profile-1:account-1", updatedAt: 1 },
        ],
      });
      await auth.expectReply(auth.complete(flow), result);
      expect(auth.writes).toEqual([auth.credential]);
      expect(auth.exchange).toHaveBeenCalledOnce();
      expect(auth.registerSecretValueForRedaction).toHaveBeenCalledWith("synthetic-code");
      expect(auth.broadcast).toHaveBeenCalledExactlyOnceWith(
        "chat.metadata.changed",
        {},
        { dropIfSlow: true },
      );
      if (caller === "ingress") {
        grant.abort();
        await auth.expectError(
          auth.rpc("users.authConnect.catalog", { profileId: "profile-1" }),
          "FORBIDDEN",
        );
      }
    },
  );

  it("keeps server credentials and model defaults outside personal provider execution", async () => {
    auth.setConfig({
      models: {
        providers: {
          openai: { apiKey: "server-only-key", baseUrl: "https://api.example.test", models: [] },
        },
      },
    });
    const flow = await auth.startFlow();
    const ctx = auth.runAuth.mock.calls[0]![0];
    expect(ctx).toMatchObject({
      config: {},
      env: {},
      existingProfiles: [],
      secretInputMode: "plaintext",
      allowSecretRefPrompt: false,
    });
    expect(ctx.agentDir).toBeUndefined();
    expect(ctx.opts).toBeUndefined();
    auth.exchange.mockResolvedValueOnce({
      ...auth.authorized,
      configPatch: { agents: { defaults: { model: "ignored/model" } } },
      defaultModel: "ignored/model",
    });
    await auth.complete(flow);
    await auth.terminal(flow, "connected");
    expect(auth.config.agents).toBeUndefined();
    expect(auth.writes).toEqual([auth.credential]);
  });

  it("offers the privately prepared selected profile without loading shared credentials", async () => {
    const authProfileId = "personal:profile-1:saved";
    auth.readSelectedUserModelAccount.mockResolvedValue({
      id: authProfileId,
      credential: auth.credential,
    });

    await auth.startFlow();

    expect(auth.runAuth.mock.calls[0]?.[0].existingProfiles).toEqual([
      { profileId: authProfileId, credential: auth.credential },
    ]);
    expect(auth.ensureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
  });

  it("retains an unknown write outcome without replaying it on status or answer", async () => {
    connectUserModelAccount.mockRejectedValueOnce(new Error("Worker outcome unknown"));
    const flow = await startFlow();
    await complete(flow);
    expect(await terminal(flow, "failed")).toEqual({ status: "failed", reason: "unavailable" });
    await complete(flow);
    await status(flow);
    expect(connectUserModelAccount).toHaveBeenCalledOnce();
  });

  it("records provider completion while a prompt is open without requiring an answer", async () => {
    const callback = createDeferredCore<ProviderAuthResult>();
    auth.runAuth.mockImplementationOnce(async (ctx) => {
      const input = ctx.prompter.text({ message: "Paste callback", sensitive: true });
      return Promise.race([input.then(() => auth.authorized), callback.promise]);
    });
    const flow = await auth.startFlow();
    callback.resolve(auth.authorized);
    expect(await auth.terminal(flow, "connected")).not.toHaveProperty("step");
    expect(auth.writes).toEqual([auth.credential]);
  });

  it("observes the next provider step after a manual prompt is retired", async () => {
    const manual = new AbortController();
    auth.runAuth.mockImplementationOnce(async (ctx) => {
      await ctx.prompter
        .text({ message: "Manual input", sensitive: true, signal: manual.signal })
        .catch(() => undefined);
      await ctx.prompter.note("Browser authorization received", "Continue sign-in");
      return auth.authorized;
    });
    const flow = await auth.startFlow();
    const first = await auth.status(flow);
    manual.abort(new Error("Browser callback won"));
    await vi.waitFor(async () =>
      expect(await auth.status(flow)).toMatchObject({ status: "pending", step: { type: "note" } }),
    );
    const next = await auth.status(flow);
    expect(next.step.id).not.toBe(first.step.id);
    await auth.expectReply(
      auth.flowRpc("answer", flow, { stepId: first.step.id, value: "stale" }),
      {
        status: "pending",
        step: next.step,
        error: expect.any(String),
      },
    );
    expect(auth.writes).toEqual([]);
    expect(await auth.status(flow)).toEqual(next);
    await auth.flowRpc("answer", flow, { stepId: next.step.id });
    await auth.terminal(flow, "connected");
    expect(auth.writes).toEqual([auth.credential]);
  });

  it("does not replay a rejected step retired during answer validation", async () => {
    const manual = new AbortController();
    auth.runAuth.mockImplementationOnce(async (ctx) => {
      await ctx.prompter
        .text({
          message: "Manual input",
          sensitive: true,
          signal: manual.signal,
          validate: () => {
            // Browser completion retires the prompt before the service resumes
            // from the Promise returned by the synchronous validator's answer.
            queueMicrotask(() => manual.abort(new Error("Browser callback won")));
            return "Rejected answer";
          },
        })
        .catch(() => undefined);
      await ctx.prompter.note("Browser authorization received", "Continue sign-in");
      return auth.authorized;
    });
    const flow = await auth.startFlow();
    const first = await auth.status(flow);
    const response = await auth.flowRpc("answer", flow, {
      stepId: first.step.id,
      value: "rejected-secret",
    });
    expect(response).toHaveBeenCalledWith(true, expect.objectContaining({ status: "pending" }));
    expect(response.mock.calls[0]?.[1]).not.toHaveProperty("error");
    expect(response.mock.calls[0]?.[1]).not.toHaveProperty("step.id", first.step.id);
    await vi.waitFor(async () =>
      expect(await auth.status(flow)).toMatchObject({ status: "pending", step: { type: "note" } }),
    );
    const next = await auth.status(flow);
    await auth.flowRpc("answer", flow, { stepId: next.step.id });
    await auth.terminal(flow, "connected");
    expect(auth.writes).toEqual([auth.credential]);
  });

  it.each(["exchange", "identity", "unavailable"] as const)(
    "records a redacted %s failure",
    async (reason) => {
      if (reason === "exchange") {
        auth.exchange.mockRejectedValueOnce(new Error("secret provider detail"));
      }
      if (reason === "identity") {
        auth.exchange.mockResolvedValueOnce({ profiles: [] });
      }
      if (reason === "unavailable") {
        auth.connectUserModelAccount.mockImplementationOnce(() => {
          throw new Error("secret database detail");
        });
      }
      const flow = await auth.startFlow();
      await auth.complete(flow);
      expect(await auth.terminal(flow, "failed")).toEqual({ status: "failed", reason });
      expect(auth.writes).toEqual([]);
    },
  );

  it.each(
    (["before", "during"] as const).flatMap((phase) =>
      (["disconnect", "invalidation", "role", "merge", "answerer disconnect"] as const).map(
        (change) => ({ phase, change }),
      ),
    ),
  )("fences $change $phase provider I/O", async ({ phase, change }) => {
    const writer: GatewayOperatorRoleDefinition = {
      agents: "*",
      scopes: ["operator.write"],
      sessions: { others: "none" },
    };
    auth.setConfig({ gateway: { roles: { default: "writer", definitions: { writer } } } });
    const deferred = createDeferredCore<ProviderAuthResult>();
    if (phase === "during") {
      auth.exchange.mockReturnValueOnce(deferred.promise);
    }
    const ready = createDeferredCore();
    const beforeIo = createDeferredCore();
    if (phase === "before") {
      auth.runAuth.mockImplementationOnce(async (ctx) => {
        const value = await ctx.prompter.text({ message: "Provider credential", sensitive: true });
        ready.resolve();
        await beforeIo.promise;
        ctx.assertCurrent?.();
        return auth.exchange(value, ctx.signal);
      });
    }
    const flow = await auth.startFlow();
    const answerer = change === "answerer disconnect" ? auth.createClient() : auth.self;
    await auth.complete(flow, "profile-1", answerer);
    if (phase === "before") {
      await ready.promise;
    } else {
      await vi.waitFor(() => expect(auth.exchange).toHaveBeenCalledOnce());
    }
    if (change === "disconnect") {
      auth.clients.delete(auth.self);
    }
    if (change === "invalidation") {
      auth.self.invalidated = true;
    }
    if (change === "role") {
      writer.scopes = ["operator.read"];
    }
    if (change === "merge") {
      auth.resolveProfileId.mockImplementation((id) =>
        id === "profile-1" ? "profile-merged" : id,
      );
    }
    if (change === "answerer disconnect") {
      auth.clients.delete(answerer);
    }
    beforeIo.resolve();
    deferred.resolve(auth.authorized);
    await Promise.allSettled([auth.runAuth.mock.results[0]!.value]);
    if (phase === "before") {
      expect(auth.exchange).not.toHaveBeenCalled();
    } else {
      expect(auth.exchange).toHaveResolved();
    }
    // A merged-away owner cannot authorize even an observation of its old operation.
    const observer = auth.createClient("profile-admin", ["operator.admin"]);
    if (change === "merge") {
      await auth.expectError(auth.flowRpc("status", flow, {}, "profile-1", observer), "FORBIDDEN");
      expect(auth.writes).toEqual([]);
      return;
    }
    auth.setConfig({});
    expect(await auth.terminal(flow, "failed", "profile-1", observer)).toEqual({
      status: "failed",
      reason: "authority",
    });
    expect(auth.writes).toEqual([]);
  });

  it.each(["cancel", "supersede", "expiry", "stop"] as const)(
    "fences late credentials after %s",
    async (change) => {
      const deferred = createDeferredCore<ProviderAuthResult>();
      auth.exchange.mockReturnValueOnce(deferred.promise);
      const flow = await auth.startFlow();
      await auth.complete(flow);
      await vi.waitFor(() => expect(auth.exchange).toHaveBeenCalledOnce());
      const signal: AbortSignal = auth.exchange.mock.calls[0]![1];
      if (change === "cancel") {
        await auth.flowRpc("cancel", flow);
      }
      if (change === "supersede") {
        auth.service.supersede("profile-1", "openai");
      }
      if (change === "expiry") {
        vi.spyOn(Date, "now").mockReturnValue(flow.expiresAtMs + 1);
      }
      if (change === "stop") {
        await auth.service.stop();
      }
      deferred.resolve(auth.authorized);
      await vi.waitFor(() => expect(auth.exchange).toHaveResolved());
      if (change === "stop") {
        auth.restartService();
      }
      expect(
        await auth.terminal(
          flow,
          change === "expiry" || change === "stop" ? "expired" : "cancelled",
        ),
      ).not.toHaveProperty("step");
      expect(signal.aborted).toBe(true);
      expect(auth.writes).toEqual([]);
    },
  );

  it("retires replaced operations without letting an old cancel affect the new one", async () => {
    const first = await auth.startFlow();
    const replacement = await auth.startFlow();
    await auth.expectReply(auth.flowRpc("cancel", first), { status: "cancelled" });
    await auth.complete(replacement);
    await auth.terminal(replacement, "connected");
    expect(auth.writes).toEqual([auth.credential]);
  });

  it("bounds concurrent sign-ins and recovers capacity after cancellation", async () => {
    const admin = auth.createClient("profile-admin", ["operator.admin"]);
    const flows = [];
    for (let index = 0; index < 8; index++) {
      flows.push(await auth.startFlow(`profile-${index}`, admin));
    }
    await auth.expectError(
      auth.rpc(
        "users.authConnect.start",
        { profileId: "profile-9", provider: "openai", method: "oauth" },
        admin,
      ),
      "UNAVAILABLE",
    );
    await auth.flowRpc("cancel", flows[0]!, {}, "profile-0", admin);
    expect((await auth.startFlow("profile-9", admin)).connectId).toBeTruthy();
  });

  it("uses the same credential boundary for a catalog-provided API key", async () => {
    const keyCredential: AuthProfileCredential = {
      type: "api_key",
      provider: "example-ai",
      key: "synthetic-key",
    };
    auth.resolvePersonalAccountAuthMethod.mockReturnValue({
      id: "api-key",
      label: "API key",
      kind: "api_key",
      run: auth.runAuth,
    });
    auth.exchange.mockResolvedValueOnce({
      profiles: [{ profileId: "ignored-id", credential: keyCredential }],
    });
    const flow = await auth.startFlow("profile-1", auth.self, "example-ai", "api-key");
    await auth.complete(flow);
    await auth.terminal(flow, "connected");
    expect(auth.writes).toEqual([keyCredential]);
    const match = auth.connectUserModelAccount.mock.calls[0]![0].matchesCredential;
    expect(match(keyCredential)).toBe(true);
    expect(match({ ...keyCredential, key: "different" })).toBe(false);
  });

  it("keeps a committed account connected when notification fails", async () => {
    auth.broadcast.mockImplementation(() => {
      throw new Error("socket notification failed");
    });
    const flow = await auth.startFlow();
    await auth.complete(flow);
    await auth.terminal(flow, "connected");
    expect(auth.writes).toEqual([auth.credential]);
    expect(auth.warn).toHaveBeenCalledWith("chat metadata change notification failed");
  });

  it("rejects unavailable methods and unauthorized owners before provider execution", async () => {
    await auth.expectError(
      auth.rpc("users.authConnect.start", {
        profileId: "profile-other",
        provider: "openai",
        method: "oauth",
      }),
      "FORBIDDEN",
    );
    expect(auth.resolvePersonalAccountAuthMethod).not.toHaveBeenCalled();
    auth.resolvePersonalAccountAuthMethod.mockReturnValueOnce(undefined);
    await auth.expectError(
      auth.rpc("users.authConnect.start", {
        profileId: "profile-1",
        provider: "other",
        method: "import-native-login",
      }),
      "INVALID_REQUEST",
    );
    expect(auth.runAuth).not.toHaveBeenCalled();
  });

  it.each([
    ["users.authConnect.start", { provider: "openai", method: "oauth" }],
    ["users.listAuthLinks", {}],
    ["users.linkAuthProfile", { authProfileId: "openai:shared" }],
    ["users.unlinkAuthProfile", { provider: "openai" }],
  ] as const)(
    "validates %s before consulting identity, state, or provider code",
    async (method, params) => {
      await auth.expectError(
        auth.rpc(method, {
          ...params,
          profileId: "profile-1",
          unexpected: true,
        }),
        "INVALID_REQUEST",
      );
      expect(auth.prepareUserProfileSelectionAuthority).not.toHaveBeenCalled();
      expect(auth.resolvePersonalAccountAuthMethod).not.toHaveBeenCalled();
      expect(auth.listUserProfileAuthLinks).not.toHaveBeenCalled();
      expect(auth.setUserProfileAuthLink).not.toHaveBeenCalled();
      expect(auth.clearUserProfileAuthLink).not.toHaveBeenCalled();
    },
  );
});
