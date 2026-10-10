import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  observeHostDataSql,
  openIncognitoTestActor,
  withIncognitoSessionBinding,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { prepareCodexNativeExecutionPolicy } from "./native-execution-policy.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const authority = { assertCurrent() {} };

it("keeps actor execution policy and rejects a retained tool after policy or generation replacement", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("codex-actor-policy-") };
  const actor = await openIncognitoTestActor(env, authority);
  const target = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:incognito-policy",
    storePath: actor.path,
  };
  try {
    await actor.sessions.create(authority, {
      sessionKey: target.sessionKey,
      entry: {
        sessionId: "policy-session",
        updatedAt: 1,
        incognito: true,
        execHost: "node",
        execNode: "synthetic-node",
      },
    });
    await withIncognitoSessionBinding({ actor }, async () => {
      const sql = observeHostDataSql();
      try {
        const params: Parameters<typeof prepareCodexNativeExecutionPolicy>[0] = {
          config: { tools: { exec: { host: "gateway" as const } } },
          agentId: "main",
          sessionKey: "harness:codex:durable-catalog-key",
          sessionTarget: { ...target },
          readRuntimeSessionEntry: true,
          sandboxAvailable: false,
        };
        const pendingNode = prepareCodexNativeExecutionPolicy(params);
        // The worker read is pending; caller changes cannot replace its captured policy inputs.
        params.execOverrides = { host: "gateway" };
        params.sessionTarget = { ...target, sessionKey: "agent:main:replacement" };
        const node = await pendingNode;
        expect(node.policy).toMatchObject({
          nativeToolSurfaceAllowed: false,
          effectiveExecHost: "node",
          node: "synthetic-node",
        });
        await patchSessionEntry({ ...target, update: () => ({ execHost: "gateway" }) });
        expect(node.assertCurrent).toThrow("execution policy changed");

        const gateway = await prepareCodexNativeExecutionPolicy({
          ...params,
          sessionTarget: target,
          execOverrides: undefined,
        });
        const execute = vi.fn(async () => ({
          content: [{ type: "text" as const, text: "executed" }],
          details: {},
        }));
        const bridge = createCodexDynamicToolBridge({
          tools: [
            {
              name: "synthetic",
              label: "Synthetic",
              description: "Synthetic effect",
              parameters: Type.Object({}),
              execute,
            },
          ],
          signal: new AbortController().signal,
          assertCurrent: gateway.assertCurrent,
          loading: "direct",
        });
        await patchSessionEntry({
          ...target,
          update: () => ({ sessionId: "replacement-session" }),
        });
        const response = await bridge.handleToolCall({
          threadId: "synthetic-thread",
          turnId: "synthetic-turn",
          callId: "synthetic-call",
          namespace: null,
          tool: "synthetic",
          arguments: {},
        });
        expect(response.success).toBe(false);
        expect(execute).not.toHaveBeenCalled();
        expect(gateway.assertCurrent).toThrow();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  } finally {
    await actor.close();
  }
});
