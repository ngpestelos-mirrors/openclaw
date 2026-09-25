import "./side-question.test-support.js";
import { expect, it, vi } from "vitest";
import * as elicitationBridge from "./elicitation-bridge.js";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import { isJsonObject } from "./protocol.js";

const {
  readCodexAppServerBindingMock,
  getSharedCodexAppServerClientMock,
  runCodexAppServerSideQuestion,
  createFakeClient,
  agentDelta,
  turnCompleted,
  sideParams,
} = await import("./side-question.test-support.js");

/** Keep the policy cases under the original parent setup and cleanup. */
export function registerSideQuestionNativePolicyTests(
  handleClientRequestWhenReady: (
    client: ReturnType<typeof createFakeClient>,
    request: Parameters<ReturnType<typeof createFakeClient>["handleRequest"]>[0],
  ) => Promise<unknown>,
) {
  it.each(["ok", "missing-app", "binding-changed", "unbound-native-app", "config-unavailable"])(
    "projects bound ask policy before side-thread forks: %s",
    async (outcome) => {
      const approvalSpy = vi.spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest");
      const rejectsReplay = outcome === "binding-changed" || outcome === "config-unavailable";
      const nativeAppConfig = {
        enabled: true,
        links: {
          account: { approvals_reviewer: "auto_review", default_tools_approval_mode: "approve" },
        },
        tools: {
          write: { enabled: false, approval_mode: "approve" },
          read: { approval_mode: "approve" },
          retired: { approval_mode: "approve" },
        },
      };
      const savedAppConfig = structuredClone(nativeAppConfig);
      const nativeConfig = {
        apps: {
          _default: { default_tools_approval_mode: "prompt", approvals_reviewer: "user" },
          "ask-app": nativeAppConfig,
          "auto-app": { default_tools_approval_mode: "prompt", approvals_reviewer: "auto_review" },
          "true-app": { default_tools_approval_mode: "approve" },
        },
      };
      const client = createFakeClient({ completeTurn: rejectsReplay });
      const baseRequest = client.request.getMockImplementation()!;
      client.request.mockImplementation(async (method: string, requestParams?: unknown) => {
        if (method === "app/installed") {
          return {
            apps: ["ask-app", "unbound-app"].map((id) => ({
              id,
              runtimeName: id,
              enabled: true,
              callable: true,
            })),
          };
        }
        if (method === "app/read") {
          expect(requestParams).toEqual({ appIds: ["ask-app"], includeTools: true });
          return {
            apps:
              outcome === "missing-app"
                ? []
                : [
                    {
                      id: "ask-app",
                      name: "Ask",
                      pluginDisplayNames: [],
                      toolSummaries: [
                        {
                          name: "write",
                          title: null,
                          description: null,
                          isEnabled: false,
                          disabledReason: null,
                          isReadOnly: false,
                        },
                        {
                          name: "read",
                          title: null,
                          description: null,
                          isEnabled: true,
                          disabledReason: null,
                          isReadOnly: true,
                        },
                      ],
                    },
                  ],
            missingAppIds: outcome === "missing-app" ? ["ask-app"] : [],
          };
        }
        if (method === "config/read") {
          if (outcome === "config-unavailable") {
            throw new Error("native config unavailable");
          }
          if (outcome === "binding-changed") {
            readCodexAppServerBindingMock.mockReturnValue({ threadId: "replacement-thread" });
          }
          return { config: nativeConfig, layers: [] };
        }
        if (method === "config/batchWrite" || method === "config/value/write") {
          throw new Error("side-question admission cannot write saved app settings");
        }
        return baseRequest(method, requestParams);
      });
      getSharedCodexAppServerClientMock.mockResolvedValue(client);
      readCodexAppServerBindingMock.mockReturnValue({
        schemaVersion: 2,
        threadId: "parent-thread",
        sessionFile: "/tmp/session-1.jsonl",
        cwd: "/tmp/workspace",
        authProfileId: "openai:work",
        model: "gpt-5.5",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        pluginAppPolicyContext: {
          fingerprint: "mixed-plugin-policy",
          apps: {
            ...(outcome === "unbound-native-app"
              ? {}
              : {
                  "ask-app": {
                    configKey: "ask",
                    marketplaceName: "openai",
                    pluginName: "ask",
                    allowDestructiveActions: true,
                    destructiveApprovalMode: "ask",
                    mcpServerNames: ["ask"],
                  },
                }),
            "true-app": {
              configKey: "true",
              marketplaceName: "openai",
              pluginName: "true",
              allowDestructiveActions: true,
              destructiveApprovalMode: "allow",
              mcpServerNames: ["true"],
            },
            "false-app": {
              configKey: "false",
              marketplaceName: "openai",
              pluginName: "false",
              allowDestructiveActions: false,
              destructiveApprovalMode: "deny",
              mcpServerNames: ["false"],
            },
            "auto-app": {
              configKey: "auto",
              marketplaceName: "openai",
              pluginName: "auto",
              allowDestructiveActions: true,
              destructiveApprovalMode: "auto",
              mcpServerNames: ["auto"],
            },
          },
          pluginAppIds: {
            ask: outcome === "unbound-native-app" ? [] : ["ask-app"],
            true: ["true-app"],
            false: ["false-app"],
            auto: ["auto-app"],
          },
        },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });

      const run = runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: { appServer: { mode: "guardian" } },
      });
      if (rejectsReplay) {
        await expect(run).rejects.toThrow(
          outcome === "binding-changed"
            ? "binding changed before fork"
            : "Could not verify the Codex app allowlist",
        );
        const methods = client.request.mock.calls.map(([method]) => method);
        expect(methods).not.toContain("config/batchWrite");
        expect(methods).not.toContain("config/value/write");
        expect(methods).not.toContain("thread/fork");
        return;
      }
      await vi.waitFor(() =>
        expect(client.request.mock.calls.map(([method]) => method)).toContain("turn/start"),
      );
      try {
        await handleClientRequestWhenReady(client, {
          id: "side-approval-policy",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "side-thread",
            turnId: "turn-1",
            serverName: "forms",
            mode: "form",
            message: "Enter a value",
            requestedSchema: { type: "object", properties: { value: { type: "string" } } },
          },
        });
        const policy = approvalSpy.mock.calls.at(-1)?.[0].pluginAppPolicyContext;
        expect(Object.keys(policy?.apps ?? {}).toSorted()).toEqual(
          outcome === "ok"
            ? ["ask-app", "auto-app", "false-app", "true-app"]
            : ["auto-app", "false-app", "true-app"],
        );
        expect(policy?.pluginAppIds.ask).toEqual(outcome === "ok" ? ["ask-app"] : []);
      } finally {
        client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
        client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
        await expect(run).resolves.toEqual({ text: "Side answer." });
      }

      const methods = client.request.mock.calls.map(([method]) => method);
      if (outcome === "unbound-native-app") {
        expect(methods).not.toContain("app/installed");
        expect(methods).not.toContain("app/read");
        expect(methods).not.toContain("config/batchWrite");
      } else {
        expect(methods.indexOf("app/read")).toBeLessThan(methods.indexOf("thread/fork"));
      }
      expect(methods.filter((method) => method === "config/read")).toHaveLength(1);
      expect(methods).not.toContain("config/batchWrite");
      expect(methods).not.toContain("config/value/write");
      expect(nativeAppConfig).toEqual(savedAppConfig);
      const forkParams = client.request.mock.calls.find(
        ([method]) => method === "thread/fork",
      )?.[1];
      if (!isJsonObject(forkParams) || !isJsonObject(forkParams.config)) {
        throw new Error("Expected side-thread fork parameters and configuration");
      }
      expect(forkParams.approvalsReviewer).toBe("auto_review");
      const config = forkParams.config;
      expect(mergeCodexThreadConfigs(nativeConfig, config)?.apps).toMatchObject({
        _default: { default_tools_approval_mode: "prompt", approvals_reviewer: "user" },
        "auto-app": { default_tools_approval_mode: "prompt", approvals_reviewer: "auto_review" },
        "true-app": { default_tools_approval_mode: "approve" },
        "false-app": { destructive_enabled: false },
      });
      expect(config).not.toHaveProperty("approvals_reviewer");
      expect(config?.["features.code_mode"]).toBe(true);
      expect(config?.apps).toEqual({
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        ...(outcome === "ok"
          ? {
              "ask-app": {
                enabled: true,
                approvals_reviewer: "user",
                destructive_enabled: true,
                open_world_enabled: true,
                default_tools_approval_mode: "auto",
                links: {
                  account: { approvals_reviewer: "user", default_tools_approval_mode: "auto" },
                },
                tools: { write: { approval_mode: "auto" } },
              },
            }
          : { "ask-app": { enabled: false } }),
        "auto-app": {
          enabled: true,
          destructive_enabled: true,
          open_world_enabled: true,
        },
        "false-app": {
          enabled: true,
          destructive_enabled: false,
          open_world_enabled: true,
        },
        "true-app": {
          enabled: true,
          destructive_enabled: true,
          open_world_enabled: true,
        },
      });
    },
  );
}
