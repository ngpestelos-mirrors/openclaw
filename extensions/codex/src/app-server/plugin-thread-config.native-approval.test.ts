import { describe, expect, it } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { appInfo } from "./plugin-inventory.test-helpers.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  buildCodexPluginThreadConfig,
  buildCodexPluginThreadConfigInputFingerprint,
  isCodexPluginThreadBindingStale,
  mergeCodexThreadConfigs,
  refreshCodexPluginAppApprovalPolicy,
} from "./plugin-thread-config.js";
import type { CodexAppServerRequestParams } from "./protocol.js";

describe("Codex native app approval settings", () => {
  it("invalidates bindings created before native approval preservation", () => {
    const currentInputFingerprint = buildCodexPluginThreadConfigInputFingerprint({
      pluginConfig: {
        codexPlugins: { enabled: true, allow_all_plugins: true, allow_destructive_actions: "auto" },
      },
      appCacheKey: "native-approval",
    });
    expect(
      isCodexPluginThreadBindingStale({
        codexPluginsEnabled: true,
        bindingFingerprint: "saved-thread-config",
        // Version 13 fingerprint for these exact inputs on release base 350368f7.
        bindingInputFingerprint: "23138754359ddbb7e60cb4cf2085e2948901a573463ebca10e144335ba0579d8",
        currentInputFingerprint,
        hasBindingPolicyContext: true,
      }),
    ).toBe(true);
  });

  it.each(
    (["app", "global"] as const).flatMap((scope) =>
      (["auto", true, false] as const).flatMap((policy) =>
        (
          [
            ["prompt", "user"],
            ["prompt", "auto_review"],
            ["approve", "user"],
          ] as const
        ).map(([mode, reviewer]) => ({ scope, policy, mode, reviewer })),
      ),
    ),
  )(
    "preserves $scope $mode with $reviewer review and OpenClaw $policy on initial and retained threads",
    async ({ scope, policy, mode, reviewer }) => {
      const nativeApp = {
        default_tools_approval_mode: mode,
        approvals_reviewer: reviewer,
        links: { account: { default_tools_approval_mode: "writes" } },
        tools: { read: { approval_mode: "approve" } },
      };
      const appConfig = scope === "app" ? nativeApp : {};
      const nativeConfig = {
        apps: {
          ...(scope === "global"
            ? { _default: { default_tools_approval_mode: mode, approvals_reviewer: reviewer } }
            : {}),
          "calendar-app": appConfig,
        },
      };
      const request = async (method: string, params?: unknown) => {
        if (method === "config/read") {
          return { config: nativeConfig, layers: [] };
        }
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(
            method,
            [appInfo("calendar-app", true)],
            params as CodexAppServerRequestParams<typeof method>,
          );
        }
        throw new Error(`unexpected request ${method}`);
      };
      const config = await buildCodexPluginThreadConfig({
        pluginConfig: {
          codexPlugins: {
            enabled: true,
            allow_all_plugins: true,
            allow_destructive_actions: policy,
          },
        },
        appCache: new CodexAppInventoryCache(),
        appCacheKey: "native-approval",
        request,
      });
      const replay = await refreshCodexPluginAppApprovalPolicy({
        policyContext: config.policyContext,
        request,
      });

      for (const patch of [
        config.configPatch,
        buildCodexPluginAppsConfigPatchFromPolicyContext(config.policyContext),
        replay.configPatch,
      ]) {
        expect(mergeCodexThreadConfigs(nativeConfig, patch)?.apps).toMatchObject({
          "calendar-app": {
            ...appConfig,
            enabled: true,
            destructive_enabled: policy !== false,
            open_world_enabled: true,
          },
        });
        if (scope === "global") {
          expect(mergeCodexThreadConfigs(nativeConfig, patch)?.apps).toMatchObject({
            _default: { default_tools_approval_mode: mode, approvals_reviewer: reviewer },
          });
          expect(patch).toHaveProperty("apps.calendar-app");
          expect(patch).not.toHaveProperty("apps.calendar-app.default_tools_approval_mode");
        }
      }
      expect(config.diagnostics).toEqual([]);
      expect(replay.diagnostics).toEqual([]);
    },
  );
});
