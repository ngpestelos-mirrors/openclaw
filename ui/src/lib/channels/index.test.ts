import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventListener } from "../../api/gateway.ts";
import type {
  ChannelsPairingApproveResult,
  ChannelsPairingListResult,
  ChannelsStatusSnapshot,
} from "../../api/types.ts";
import {
  channelSnapshotEntryIsActive,
  channelSnapshotHasActiveChannel,
  createChannelCapability,
} from "./index.ts";

type GatewaySnapshot = Parameters<typeof createChannelCapability>[0]["snapshot"];
type LoginResult = { message: string; connected: boolean; qrDataUrl: string };

function loginResult(message: string, connected: boolean, qr: string): LoginResult {
  return { message, connected, qrDataUrl: `data:image/png;base64,${qr}` };
}

function createChannels(request: ReturnType<typeof vi.fn>, scopes?: string[]) {
  let snapshot: GatewaySnapshot = {
    client: { request },
    phase: "connected",
    ...(scopes ? { hello: { auth: { role: "operator", scopes } } } : {}),
  };
  const listeners = new Set<(next: GatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const channels = createChannelCapability({
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents(listener: GatewayEventListener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  });
  return {
    channels,
    publish: (patch: Partial<GatewaySnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    emitEvent: (event: string) => {
      for (const listener of eventListeners) {
        listener({ type: "event", event, payload: {} });
      }
    },
  };
}

function createChannelsSnapshot(label: string): ChannelsStatusSnapshot {
  return {
    ts: Date.now(),
    channelOrder: ["test"],
    channelLabels: { test: label },
    channels: {},
    channelAccounts: {},
    channelDefaultAccountId: {},
  };
}

describe("channel readiness", () => {
  it("treats aggregate or account configuration as active", () => {
    const snapshot = createChannelsSnapshot("Test");
    snapshot.channelOrder = ["configured", "connected", "empty"];
    snapshot.channels = {
      configured: { configured: true },
      connected: { configured: false, connected: false },
      empty: { configured: false, running: false, connected: false },
    };
    snapshot.channelAccounts = {
      connected: [{ accountId: "work", connected: true }],
      empty: [],
    };

    expect(channelSnapshotEntryIsActive(snapshot, "configured")).toBe(true);
    expect(channelSnapshotEntryIsActive(snapshot, "connected")).toBe(true);
    expect(channelSnapshotEntryIsActive(snapshot, "empty")).toBe(false);
    expect(channelSnapshotHasActiveChannel(snapshot)).toBe(true);
  });

  it("recognizes active channels omitted from channelOrder", () => {
    const snapshot = createChannelsSnapshot("Test");
    snapshot.channelOrder = [];
    snapshot.channelAccounts = {
      telegram: [{ accountId: "default", running: true }],
    };

    expect(channelSnapshotHasActiveChannel(snapshot)).toBe(true);
    expect(channelSnapshotHasActiveChannel(null)).toBe(false);
  });
});

describe("channels controller WhatsApp", () => {
  it("rejects a stale login result after reconnecting with the same client", async () => {
    const staleWait = createDeferred<LoginResult>();
    const freshWait = createDeferred<LoginResult>();
    let waitCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "web.login.wait") {
        waitCount += 1;
        return waitCount === 1 ? staleWait.promise : freshWait.promise;
      }
      return Promise.resolve(createChannelsSnapshot("fresh"));
    });
    const { channels, publish } = createChannels(request);

    const stale = channels.waitWhatsApp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    publish({ phase: "reconnecting" });
    publish({ phase: "connected" });

    const fresh = channels.waitWhatsApp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    freshWait.resolve(loginResult("fresh login", false, "fresh-qr"));
    await fresh;

    staleWait.resolve(loginResult("stale login", true, "stale-qr"));
    await stale;

    expect(channels.state.whatsappLoginMessage).toBe("fresh login");
    expect(channels.state.whatsappLoginQrDataUrl).toBe("data:image/png;base64,fresh-qr");
    expect(request.mock.calls.filter(([method]) => method === "channels.status")).toHaveLength(1);
    channels.dispose();
  });

  it("keeps an active login wait across pairing-scope changes", async () => {
    const pending = createDeferred<LoginResult>();
    const request = vi.fn((method: string) =>
      method === "web.login.wait"
        ? pending.promise
        : Promise.resolve(createChannelsSnapshot("refreshed")),
    );
    const { channels, publish } = createChannels(request, ["operator.pairing"]);

    const wait = channels.waitWhatsApp();
    await vi.waitFor(() => expect(channels.state.whatsappBusy).toBe(true));
    publish({
      hello: { auth: { role: "operator", scopes: ["operator.pairing", "operator.read"] } },
    });
    expect(channels.state.whatsappBusy).toBe(true);

    pending.resolve(loginResult("login survived scope change", false, "scope-change"));
    await wait;

    expect(channels.state.whatsappLoginMessage).toBe("login survived scope change");
    expect(channels.state.whatsappLoginQrDataUrl).toBe("data:image/png;base64,scope-change");
    channels.dispose();
  });

  it("rejects an active login result when admin access is revoked", async () => {
    const pending = createDeferred<LoginResult>();
    const request = vi.fn(() => pending.promise);
    const { channels, publish } = createChannels(request, ["operator.admin", "operator.pairing"]);
    channels.state.whatsappLoginQrDataUrl = "data:image/png;base64,existing";
    channels.state.whatsappLoginSessionKey = "existing-session";

    const wait = channels.waitWhatsApp();
    await vi.waitFor(() => expect(channels.state.whatsappBusy).toBe(true));
    publish({
      hello: { auth: { role: "operator", scopes: ["operator.pairing"] } },
    });
    expect(channels.state.whatsappBusy).toBe(false);
    expect(channels.state.whatsappLoginQrDataUrl).toBeNull();
    expect(channels.state.whatsappLoginSessionKey).toBeNull();

    pending.resolve(loginResult("stale login", true, "stale"));
    await wait;

    expect(channels.state.whatsappLoginMessage).toBeNull();
    expect(channels.state.whatsappLoginQrDataUrl).toBeNull();
    channels.dispose();
  });

  it("does not apply or refresh a login result after its capability is disposed", async () => {
    const pending = createDeferred<LoginResult>();
    const request = vi.fn(() => pending.promise);
    const { channels } = createChannels(request);

    const wait = channels.waitWhatsApp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    channels.dispose();
    pending.resolve(loginResult("stale login", true, "stale-qr"));
    await wait;

    expect(channels.state.whatsappLoginMessage).toBeNull();
    expect(channels.state.whatsappLoginQrDataUrl).toBeNull();
    expect(request).toHaveBeenCalledOnce();

    await channels.waitWhatsApp();
    expect(request).toHaveBeenCalledOnce();
  });
  it("carries the provider session key from login start into wait", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "web.login.start") {
        return { message: "scan", sessionKey: "opaque-session" };
      }
      if (method === "web.login.wait") {
        return { connected: true, message: "connected" };
      }
      return createChannelsSnapshot("refreshed");
    });
    const { channels } = createChannels(request);

    await channels.startWhatsApp(false);
    await channels.waitWhatsApp();

    expect(request).toHaveBeenCalledWith(
      "web.login.start",
      expect.objectContaining({ channel: "whatsapp" }),
    );
    expect(request).toHaveBeenCalledWith(
      "web.login.wait",
      expect.objectContaining({ channel: "whatsapp", sessionKey: "opaque-session" }),
    );
    expect(channels.state.whatsappLoginSessionKey).toBeNull();
    channels.dispose();
  });
  it("preserves login state when no stored session was cleared", async () => {
    const request = vi.fn(async (method: string) =>
      method === "channels.logout"
        ? { cleared: false, loggedOut: false }
        : createChannelsSnapshot("refreshed"),
    );
    const { channels } = createChannels(request);
    channels.state.whatsappLoginMessage = "Scan this QR.";
    channels.state.whatsappLoginQrDataUrl = "data:image/png;base64,current-qr";
    channels.state.whatsappLoginConnected = true;

    await channels.logoutWhatsApp("work");

    expect(request).toHaveBeenCalledWith("channels.logout", {
      channel: "whatsapp",
      accountId: "work",
    });
    expect(request.mock.calls.filter(([method]) => method === "channels.status")).toHaveLength(1);
    expect(channels.state.whatsappLoginMessage).toBe(
      "No stored WhatsApp session was cleared. It may already be absent, or its auth directory may require manual cleanup.",
    );
    expect(channels.state.whatsappLoginQrDataUrl).toBe("data:image/png;base64,current-qr");
    expect(channels.state.whatsappLoginConnected).toBe(true);
    expect(channels.state.whatsappBusy).toBe(false);
    channels.dispose();
  });

  it("clears login state only when the Gateway confirms session clearance", async () => {
    const request = vi.fn(async (method: string) =>
      method === "channels.logout"
        ? { cleared: true, loggedOut: true }
        : createChannelsSnapshot("refreshed"),
    );
    const { channels } = createChannels(request);
    channels.state.whatsappLoginMessage = "Scan this QR.";
    channels.state.whatsappLoginQrDataUrl = "data:image/png;base64,current-qr";
    channels.state.whatsappLoginConnected = true;

    await channels.logoutWhatsApp();

    expect(channels.state.whatsappLoginMessage).toBe("Logged out.");
    expect(channels.state.whatsappLoginQrDataUrl).toBeNull();
    expect(channels.state.whatsappLoginConnected).toBeNull();
    expect(channels.state.whatsappBusy).toBe(false);
    channels.dispose();
  });
  it.each([
    ["login", "web.login.start", false],
    ["scan wait", "web.login.wait", true],
  ] as const)(
    "publishes a rejected %s without probing channel status",
    async (operation, method, preservesQr) => {
      const request = vi.fn(async (requestedMethod: string) => {
        if (requestedMethod === method) {
          throw new Error("WhatsApp request rejected");
        }
        return createChannelsSnapshot("unexpected refresh");
      });
      const { channels } = createChannels(request);
      channels.state.whatsappLoginQrDataUrl = "data:image/png;base64,current-qr";
      channels.state.whatsappLoginConnected = true;
      const updates: Array<{ busy: boolean; message: string | null }> = [];
      channels.subscribe((state) => {
        updates.push({ busy: state.whatsappBusy, message: state.whatsappLoginMessage });
      });

      await (operation === "login" ? channels.startWhatsApp(false) : channels.waitWhatsApp());

      expect(
        request.mock.calls.filter(([requestedMethod]) => requestedMethod === "channels.status"),
      ).toHaveLength(0);
      expect(updates.at(-1)).toEqual({ busy: false, message: "WhatsApp request rejected" });
      expect(channels.state.whatsappLoginQrDataUrl).toBe(
        preservesQr ? "data:image/png;base64,current-qr" : null,
      );
      expect(channels.state.whatsappLoginConnected).toBeNull();
      channels.dispose();
    },
  );
});

describe("channels controller DM pairing", () => {
  const pairingParams = { channel: "whatsapp", accountId: "personal", requestId: "request-1" };
  const approvalParams = { ...pairingParams, notify: false, bootstrapCommandOwner: false };
  const approved: ChannelsPairingApproveResult = {
    requestId: "request-1",
    senderId: "+1555",
    notification: "not-requested",
    commandOwnerBootstrap: "not-requested",
  };
  const emptyPairing: ChannelsPairingListResult = {
    accounts: [],
    requests: [],
    commandOwnerConfigured: true,
    limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
  };
  const account = {
    channel: "whatsapp",
    channelLabel: "WhatsApp",
    accountId: "personal",
    notifySupported: true,
  };
  const pendingPairing: ChannelsPairingListResult = {
    ...emptyPairing,
    accounts: [account],
    requests: [
      {
        ...account,
        requestId: "request-1",
        senderId: "+1555",
        senderLabel: "Phone number",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:00:00.000Z",
        expiresAt: "2026-07-20T11:00:00.000Z",
      },
    ],
  };

  it("loads pending requests and refreshes after dismissal", async () => {
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "channels.pairing.list") {
        listCount += 1;
        return listCount === 1 ? pendingPairing : emptyPairing;
      }
      return {};
    });
    const { channels } = createChannels(request);

    await channels.refreshPairing();
    expect(channels.state.pairingSnapshot?.requests).toHaveLength(1);

    await expect(channels.dismissPairing(pairingParams)).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("channels.pairing.dismiss", pairingParams);
    expect(channels.state.pairingSnapshot?.requests).toEqual([]);
    expect(channels.state.pairingBusyRequestId).toBeNull();
    channels.dispose();
  });

  it("keeps the row resolved when refresh fails and blocks polling during mutation", async () => {
    const approvalResult = createDeferred<ChannelsPairingApproveResult>();
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "channels.pairing.list") {
        listCount += 1;
        if (listCount === 1) {
          return pendingPairing;
        }
        throw new Error("refresh unavailable");
      }
      return approvalResult.promise;
    });
    const { channels } = createChannels(request);
    await channels.refreshPairing();

    const approval = channels.approvePairing(approvalParams);
    await vi.waitFor(() => expect(channels.state.pairingBusyRequestId).toBe("request-1"));
    await channels.refreshPairing();
    expect(listCount).toBe(1);

    approvalResult.resolve(approved);
    await approval;

    expect(channels.state.pairingSnapshot?.requests).toEqual([]);
    expect(channels.state.pairingError).toBe("refresh unavailable");
    channels.dispose();
  });

  it("does not let a pre-approval list restore the resolved request", async () => {
    const staleList = createDeferred<ChannelsPairingListResult>();
    const freshList = createDeferred<ChannelsPairingListResult>();
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "channels.pairing.list") {
        listCount += 1;
        return listCount === 1 ? staleList.promise : freshList.promise;
      }
      return approved;
    });
    const { channels } = createChannels(request);

    const staleRefresh = channels.refreshPairing();
    await vi.waitFor(() => expect(listCount).toBe(1));
    const approval = channels.approvePairing(approvalParams);
    await vi.waitFor(() => expect(listCount).toBe(2));
    freshList.resolve(emptyPairing);
    await approval;

    staleList.resolve(pendingPairing);
    await staleRefresh;

    expect(channels.state.pairingSnapshot?.requests).toEqual([]);
    channels.dispose();
  });

  it("retains sender metadata on disconnect and clears it on pairing-scope changes", () => {
    const { channels, publish } = createChannels(vi.fn(), ["operator.pairing"]);
    channels.state.pairingSnapshot = pendingPairing;

    publish({ phase: "reconnecting" });
    expect(channels.state.pairingSnapshot).toBe(pendingPairing);

    publish({
      phase: "connected",
      hello: { auth: { role: "operator", scopes: ["operator.read"] } },
    });
    expect(channels.state.pairingSnapshot).toBeNull();

    channels.state.pairingSnapshot = pendingPairing;
    publish({ client: { request: vi.fn() } });
    expect(channels.state.pairingSnapshot).toBeNull();
    channels.dispose();
  });

  it("ignores a pairing mutation result from an earlier authorization epoch", async () => {
    const approval = createDeferred<ChannelsPairingApproveResult>();
    const request = vi.fn(async (method: string) => {
      if (method === "channels.pairing.approve") {
        return approval.promise;
      }
      return emptyPairing;
    });
    const { channels, publish } = createChannels(request, ["operator.pairing"]);
    channels.state.pairingSnapshot = pendingPairing;

    const pendingApproval = channels.approvePairing(approvalParams);
    await vi.waitFor(() => expect(channels.state.pairingBusyRequestId).toBe("request-1"));
    publish({
      hello: { auth: { role: "operator", scopes: ["operator.pairing", "operator.read"] } },
    });
    channels.state.pairingSnapshot = pendingPairing;

    approval.resolve(approved);

    await expect(pendingApproval).resolves.toBeNull();
    expect(channels.state.pairingSnapshot).toBe(pendingPairing);
    expect(request.mock.calls.filter(([method]) => method === "channels.pairing.list")).toEqual([]);
    channels.dispose();
  });
});

describe("channel refresh sequencing", () => {
  it("refreshes configured channel status when the Gateway accepts the saved configuration", async () => {
    const unconfigured = createChannelsSnapshot("Test");
    const configured = {
      ...unconfigured,
      channels: { test: { configured: true, running: true } },
    };
    const request = vi.fn().mockResolvedValueOnce(unconfigured).mockResolvedValueOnce(configured);
    const { channels, emitEvent } = createChannels(request);
    await channels.refresh(true);
    expect(channelSnapshotHasActiveChannel(channels.state.channelsSnapshot)).toBe(false);
    const refreshed = createDeferred();
    channels.subscribe((state) => {
      if (state.channelsSnapshot === configured && !state.channelsLoading) {
        refreshed.resolve();
      }
    });

    emitEvent("config.changed");

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("channels.status", {
      probe: false,
      timeoutMs: 8000,
    });
    await refreshed.promise;
    expect(channelSnapshotHasActiveChannel(channels.state.channelsSnapshot)).toBe(true);
    channels.dispose();
  });

  it.each(["pending", "settling"] as const)(
    "coalesces config changes ahead of a probe while the status read is %s",
    async (probeTiming) => {
      const pending = createDeferred<ChannelsStatusSnapshot>();
      const slowProbe = createDeferred<ChannelsStatusSnapshot>();
      const configured = createChannelsSnapshot("configured");
      const request = vi
        .fn()
        .mockImplementation((_method: string, params: { probe: boolean }) =>
          params.probe ? slowProbe.promise : Promise.resolve(configured),
        )
        .mockReturnValueOnce(pending.promise);
      const { channels, emitEvent } = createChannels(request);
      const refresh = channels.refresh();

      emitEvent("config.changed");
      emitEvent("config.changed");
      emitEvent("config.changed");
      expect(request).toHaveBeenCalledOnce();
      const probe =
        probeTiming === "pending"
          ? channels.refresh(true)
          : pending.promise.then(() => channels.refresh(true));
      try {
        pending.resolve(createChannelsSnapshot("before save"));
        await refresh;

        expect(channels.state.channelsSnapshot).toBe(configured);
        expect(channels.state.channelsLoading).toBe(false);
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenLastCalledWith("channels.status", {
          probe: false,
          timeoutMs: 8000,
        });
      } finally {
        slowProbe.resolve(createChannelsSnapshot("probe"));
        await probe;
        channels.dispose();
      }
    },
  );

  it.each(["reconnect", "read access", "dispose"] as const)(
    "retires a pending config refresh after %s changes",
    async (transition) => {
      const pending = createDeferred<ChannelsStatusSnapshot>();
      const request = vi.fn().mockReturnValue(pending.promise);
      const { channels, publish, emitEvent } = createChannels(request, ["operator.read"]);
      const refresh = channels.refresh();
      emitEvent("config.changed");

      if (transition === "reconnect") {
        publish({ phase: "reconnecting" });
        publish({ phase: "connected" });
      } else if (transition === "read access") {
        publish({
          hello: { auth: { role: "operator", scopes: ["operator.pairing"] } },
        });
      } else {
        channels.dispose();
        emitEvent("config.changed");
      }
      pending.resolve(createChannelsSnapshot("retired"));
      await refresh;

      expect(request).toHaveBeenCalledOnce();
      expect(channels.state.channelsSnapshot).toBeNull();
      channels.dispose();
    },
  );

  it("clears a failed request generation on reconnect so status can recover", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("status unavailable"))
      .mockResolvedValueOnce(createChannelsSnapshot("recovered"));
    const { channels, publish } = createChannels(request);

    await channels.refresh();
    expect(channels.state.channelsError).toBe("status unavailable");

    publish({ phase: "reconnecting" });
    publish({ phase: "connected" });

    expect(channels.state.channelsError).toBeNull();
    await channels.refresh();
    expect(channels.state.channelsSnapshot?.channelLabels.test).toBe("recovered");
    channels.dispose();
  });

  it("rejects an in-flight channel snapshot after read access is revoked", async () => {
    const pending = createDeferred<ChannelsStatusSnapshot | null>();
    const request = vi.fn(() => pending.promise);
    const { channels, publish } = createChannels(request, ["operator.read"]);

    const refresh = channels.refresh();
    await vi.waitFor(() => expect(channels.state.channelsLoading).toBe(true));
    publish({
      hello: { auth: { role: "operator", scopes: ["operator.pairing"] } },
    });
    expect(channels.state.channelsLoading).toBe(false);
    expect(channels.state.channelsSnapshot).toBeNull();

    pending.resolve(createChannelsSnapshot("stale"));
    await refresh;

    expect(channels.state.channelsSnapshot).toBeNull();
    channels.dispose();
  });

  it("refreshes accepted config without waiting for a stale slow probe", async () => {
    const slowProbe = createDeferred<ChannelsStatusSnapshot | null>();
    const fastRuntime = createDeferred<ChannelsStatusSnapshot | null>();
    const request = vi.fn(async (_method: string, params?: unknown) =>
      (params as { probe?: boolean } | undefined)?.probe ? slowProbe.promise : fastRuntime.promise,
    );
    const { channels, emitEvent } = createChannels(request);
    const runtimeLoaded = createDeferred();
    const fresh = createChannelsSnapshot("fresh");
    channels.subscribe((state) => {
      if (state.channelsSnapshot === fresh && !state.channelsLoading) {
        runtimeLoaded.resolve();
      }
    });

    const probeLoad = channels.refresh(true);
    emitEvent("config.changed");
    expect(request).toHaveBeenCalledTimes(2);

    fastRuntime.resolve(fresh);
    await runtimeLoaded.promise;
    slowProbe.resolve(createChannelsSnapshot("stale"));
    await probeLoad;

    expect(channels.state.channelsSnapshot?.channelLabels.test).toBe("fresh");
    expect(channels.state.channelsLoading).toBe(false);
    channels.dispose();
  });
});
