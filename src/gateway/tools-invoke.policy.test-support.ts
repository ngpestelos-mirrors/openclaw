import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { expect, it, type Mock } from "vitest";
import type { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

type ToolPolicySuite = {
  getConfig: () => Record<string, unknown>;
  setConfig: (config: Record<string, unknown>) => void;
  invokeToolAuthed: (params: {
    tool: string;
    args?: Record<string, unknown>;
    sessionKey?: string;
  }) => Promise<Response>;
};

export function registerToolsInvokeUploadTests({
  getConfig,
  setConfig,
  getPort,
  hookMocks,
  postToolsInvoke,
  gatewayAdminHeaders,
  invokeToolsRpc,
  setMainAllowedTools,
  invokeToolAuthed,
  expectOkInvokeResponse,
}: ToolPolicySuite & {
  getPort: () => number;
  hookMocks: {
    uploadToolExecute: Mock<AnyAgentTool["execute"]>;
    runBeforeToolCallHook: Mock<typeof runBeforeToolCallHook>;
  };
  postToolsInvoke: (params: {
    port: number;
    headers?: Record<string, string>;
    body: Record<string, unknown>;
  }) => Promise<Response>;
  gatewayAdminHeaders: () => Record<string, string>;
  invokeToolsRpc: (
    params: Record<string, unknown>,
    scopes?: string[],
    clientInfo?: { id: string; mode: string },
  ) => Promise<
    | [boolean, { ok?: boolean; toolName?: string; output?: unknown; error?: unknown }?, unknown?]
    | undefined
  >;
  setMainAllowedTools: (params: { allow: string[] }) => void;
  expectOkInvokeResponse: (res: Response) => Promise<unknown>;
}): void {
  it.each([
    { tool: "file_write", args: { contentBase64: "cHJvb2Y=" } },
    { tool: "file_write", args: { contentBase64: "" } },
    { tool: "workboard_attachment_add", args: { contentBase64: "cHJvb2Y=" } },
    { tool: "message", args: { action: "send", buffer: "cHJvb2Y=" } },
    { tool: "message", args: { action: "send", media: "data:image/png;base64,cHJvb2Y=" } },
  ])("blocks new bytes through HTTP and RPC for $tool $args", async ({ tool, args }) => {
    setConfig({ gateway: { uploads: { enabled: false } } });
    const res = await postToolsInvoke({
      port: getPort(),
      headers: gatewayAdminHeaders(),
      body: {
        name: tool,
        args,
        conversationReadOrigin: "delegated",
        internal: { syntheticClient: true },
      },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: {
        type: "tool_call_blocked",
        message: expect.stringContaining("gateway.uploads.enabled"),
      },
    });
    const rpc = await invokeToolsRpc({ name: tool, args }, ["operator.admin"], {
      id: "gateway-client",
      mode: "backend",
    });
    expect(rpc?.[1]).toMatchObject({
      ok: false,
      error: { code: "forbidden", message: expect.stringContaining("gateway.uploads.enabled") },
    });
    expect(hookMocks.uploadToolExecute).not.toHaveBeenCalled();
    expect(hookMocks.runBeforeToolCallHook).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "default",
      enabled: undefined,
      tool: "file_write",
      args: { contentBase64: "cHJvb2Y=" },
    },
    {
      label: "enabled",
      enabled: true,
      tool: "workboard_attachment_add",
      args: { contentBase64: "cHJvb2Y=" },
    },
    {
      label: "existing-media",
      enabled: false,
      tool: "file_write",
      args: { sourceMediaId: "existing-file" },
    },
    {
      label: "existing-output",
      enabled: false,
      tool: "message",
      args: { action: "send", media: "https://example.test/generated.png" },
    },
    {
      label: "plain-text",
      enabled: false,
      tool: "message",
      args: { action: "send", message: "hello" },
    },
  ])("preserves $label tool use", async ({ enabled, tool, args }) => {
    setMainAllowedTools({ allow: [tool, "upload-fixture"] });
    getConfig().gateway = { uploads: { enabled } };
    const res = await invokeToolAuthed({ tool, args });
    await expectOkInvokeResponse(res);
    const rpc = await invokeToolsRpc({ name: tool, args });
    expect(rpc?.[1]?.ok).toBe(true);
    expect(hookMocks.uploadToolExecute).toHaveBeenCalledTimes(2);
  });

  it("rechecks current upload config after awaited tool preparation", async () => {
    setMainAllowedTools({ allow: ["file_write", "upload-fixture"] });
    getConfig().gateway = { uploads: { enabled: true } };
    hookMocks.runBeforeToolCallHook.mockImplementationOnce(async (input) => {
      getConfig().gateway = { uploads: { enabled: false } };
      return { blocked: false, params: input.params };
    });
    const res = await invokeToolAuthed({ tool: "file_write", args: { contentBase64: "cHJvb2Y=" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("gateway.uploads.enabled") },
    });
    expect(hookMocks.uploadToolExecute).not.toHaveBeenCalled();
  });

  it("preserves host-attested synthetic RPC tool execution", async () => {
    setMainAllowedTools({ allow: ["file_write", "upload-fixture"] });
    getConfig().gateway = { uploads: { enabled: false } };
    const rpc = await withPluginRuntimeGatewayRequestScope(
      { client: createSyntheticPluginRuntimeClient(), isWebchatConnect: () => false },
      () => invokeToolsRpc({ name: "file_write", args: { contentBase64: "cHJvb2Y=" } }),
    );
    expect(rpc?.[1]?.ok).toBe(true);
    expect(hookMocks.uploadToolExecute).toHaveBeenCalledOnce();
  });
}

async function readToolErrorResponse(res: Response) {
  const body: unknown = await res.json();
  if (!isRecord(body) || !isRecord(body.error)) {
    throw new Error("Expected a tool error response body");
  }
  return { ok: body.ok, error: body.error };
}

export function registerToolsInvokeErrorTests({
  getConfig,
  setConfig,
  invokeToolAuthed,
}: ToolPolicySuite): void {
  it("maps tool input/auth errors to 400/403 and unexpected execution errors to 500", async () => {
    setConfig({
      ...getConfig(),
      agents: {
        list: [{ id: "main", default: true, tools: { allow: ["tools_invoke_test"] } }],
      },
    });

    const inputRes = await invokeToolAuthed({
      tool: "tools_invoke_test",
      args: { mode: "input" },
      sessionKey: "main",
    });
    expect(inputRes.status).toBe(400);
    const inputBody = await readToolErrorResponse(inputRes);
    expect(inputBody.ok).toBe(false);
    expect(inputBody.error?.type).toBe("tool_error");
    expect(inputBody.error?.message).toBe("mode invalid");

    const authRes = await invokeToolAuthed({
      tool: "tools_invoke_test",
      args: { mode: "auth" },
      sessionKey: "main",
    });
    expect(authRes.status).toBe(403);
    const authBody = await readToolErrorResponse(authRes);
    expect(authBody.ok).toBe(false);
    expect(authBody.error?.type).toBe("tool_error");
    expect(authBody.error?.message).toBe("mode forbidden");

    const crashRes = await invokeToolAuthed({
      tool: "tools_invoke_test",
      args: { mode: "crash" },
      sessionKey: "main",
    });
    expect(crashRes.status).toBe(500);
    const crashBody = await readToolErrorResponse(crashRes);
    expect(crashBody.ok).toBe(false);
    expect(crashBody.error?.type).toBe("tool_error");
    expect(crashBody.error?.message).toBe("tool execution failed");
  });
}

export function createUploadToolFixtures(execute: AnyAgentTool["execute"]) {
  const uploadTools = ["file_write", "workboard_attachment_add", "message"].map((name) => ({
    name,
    label: name,
    description: "Upload boundary fixture",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute,
  }));
  for (const tool of uploadTools) {
    if (tool.name !== "message") {
      setPluginToolMeta(tool, { pluginId: "upload-fixture", optional: true });
    }
  }
  return uploadTools;
}
