// Production approval custody + durable decision + config writer, with synthetic identities.
import fs from "node:fs";
import { expect, vi } from "vitest";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { ChannelApprovalCapability } from "../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { getOperatorApprovalDetailed } from "../operator-approval-store.js";
import { createApprovalHandlers } from "./approval.js";
import { createApprovalInvocation, createClient, createContext } from "./approval.test-support.js";
import type { GatewayRequestContext } from "./types.js";

export const reviewerConfig: OpenClawConfig = {
  commands: { ownerAllowFrom: ["telegram:42"] },
  channels: {
    telegram: { botToken: "fixture-no-network-token", execApprovals: { approvers: ["99"] } },
  },
};

export async function verifySystemAgentReviewerBoundary(params: {
  outcome:
    | "configured-delegate"
    | "unauthorized"
    | "revoked-reviewer"
    | "revoked-requester"
    | "unattended";
  manager: ExecApprovalManager<SystemAgentApprovalRequestPayload>;
  operationalRunInstance: OperationalRunInstanceRef;
  context: GatewayRequestContext;
  configPath: string;
  approvalDatabasePath: string;
  requested: { promise: Promise<unknown> };
  callChat: (
    params: Record<string, unknown>,
  ) => Promise<{ ok: boolean; payload?: unknown; error?: unknown }>;
}) {
  const telegram = await loadBundledPluginFacade<{
    telegramApprovalCapability: ChannelApprovalCapability;
    listTelegramAccountIds: (cfg: OpenClawConfig) => string[];
    resolveDefaultTelegramAccountId: (cfg: OpenClawConfig) => string;
  }>({ pluginId: "telegram", artifactBasename: "test-api" });
  const registry = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "bundled",
        plugin: {
          ...createChannelTestPluginBase({
            id: "telegram",
            config: {
              listAccountIds: telegram.listTelegramAccountIds,
              defaultAccountId: telegram.resolveDefaultTelegramAccountId,
            },
          }),
          approvalCapability: telegram.telegramApprovalCapability,
        },
      },
    ]),
  );
  const controller = new AbortController();
  const initial = fs.readFileSync(params.configPath, "utf8");
  let config: OpenClawConfig = JSON.parse(initial);
  const context = { ...createContext(), ...params.context, getRuntimeConfig: () => config };
  if (params.outcome === "unattended") {
    params.context.hasExecApprovalClients = () => false;
    params.context.forwardSystemAgentApprovalRequest = async () => false;
  }
  const pending = withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey: "agent:main:main",
      operationalRunInstance: params.operationalRunInstance,
      fullPermission: true,
      approvalSignals: [controller.signal],
    },
    () =>
      params.callChat({
        sessionId: "delegate-full",
        message: "config set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback true",
        delegation: {
          agentId: "main",
          sessionKey: "agent:main:main",
          turnSourceChannel: "telegram",
          turnSourceAccountId: "default",
        },
      }),
  );
  try {
    expect(
      await Promise.race([
        params.requested.promise.then(() => "requested"),
        pending.then(() => "settled"),
      ]),
    ).toBe("requested");
    const [record] = await params.manager.listPendingRecords();
    expect(record).toBeDefined();
    expect(fs.readFileSync(params.configPath, "utf8")).toBe(initial);
    if (params.outcome !== "unattended") {
      const persistence = {
        runtimeEpoch: params.manager.runtimeEpoch,
        databaseOptions: { path: params.approvalDatabasePath },
      };
      const handlers = createApprovalHandlers({
        execApprovalManager: new ExecApprovalManager({ persistence }),
        pluginApprovalManager: new ExecApprovalManager<PluginApprovalRequestPayload>({
          approvalKind: "plugin",
          persistence,
        }),
        systemAgentApprovalManager: params.manager,
        databaseOptions: { path: params.approvalDatabasePath },
      });
      // Server-authenticated approval runtime, not a request-supplied scope.
      const client = createClient({ internal: true });
      const invocation = createApprovalInvocation({
        handlers,
        method: "approval.resolve",
        client,
        context,
        body: {
          id: record!.id,
          kind: "system-agent",
          decision: "allow-once",
          reviewer: {
            channel: "telegram",
            accountId: "default",
            senderId: params.outcome === "unauthorized" ? "100" : "99",
          },
        },
      });
      const resolveDetailed = params.manager.resolveDetailed.bind(params.manager);
      // Initial custody succeeds. Revoke after the handler prepares its guard,
      // immediately before the real durable decision owner uses it.
      const reviewerResolution =
        params.outcome === "revoked-reviewer"
          ? vi.spyOn(params.manager, "resolveDetailed").mockImplementationOnce(async (...args) => {
              config = {
                ...config,
                channels: {
                  telegram: { ...config.channels?.telegram, execApprovals: { approvers: ["101"] } },
                },
              };
              return await resolveDetailed(...args);
            })
          : undefined;
      if (params.outcome === "revoked-requester") {
        controller.abort();
      }
      const response = await invocation.invoke();
      if (params.outcome === "configured-delegate") {
        expect(response.ok).toBe(true);
        expect(response.result).toMatchObject({ applied: true, approval: { status: "allowed" } });
        expect((await pending).payload).toMatchObject({
          reply: expect.stringContaining("[openclaw] done: config.set"),
        });
        expect(
          JSON.parse(fs.readFileSync(params.configPath, "utf8")).gateway.controlUi
            .dangerouslyAllowHostHeaderOriginFallback,
        ).toBe(true);
        return;
      }
      expect(response.result).not.toEqual(expect.objectContaining({ applied: true }));
      if (params.outcome === "unauthorized" || params.outcome === "revoked-reviewer") {
        if (params.outcome === "revoked-reviewer") {
          expect(reviewerResolution).toHaveBeenCalledOnce();
        }
        expect(
          await getOperatorApprovalDetailed({
            id: record!.id,
            databaseOptions: { path: params.approvalDatabasePath },
          }),
        ).toMatchObject({ outcome: "found", record: { status: "pending" } });
      }
      expect(fs.readFileSync(params.configPath, "utf8")).toBe(initial);
    }
    controller.abort();
    expect((await pending).payload).toMatchObject({ reply: expect.stringContaining("cancelled") });
    expect(fs.readFileSync(params.configPath, "utf8")).toBe(initial);
    expect(await params.manager.listPendingRecords()).toEqual([]);
  } finally {
    controller.abort();
    await pending;
    restoreActivePluginRegistrySnapshot(registry);
  }
}
