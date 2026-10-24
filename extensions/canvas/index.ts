import { randomUUID } from "node:crypto";
import { A2uiMessageSchema as A2uiV09MessageSchema } from "@a2ui/web_core/v0_9";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import { canvasConfigSchema, isCanvasHostEnabled } from "./src/config.js";
import { A2UI_PATH } from "./src/host/a2ui-shared.js";
import { CANVAS_PRESENT_COMMAND, isEligibleCanvasNode } from "./src/node-eligibility.js";
import { canvasToolDefinition } from "./src/tool-schema.js";

const DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS = 30_000;
const CANVAS_NODE_COMMANDS = ["canvas.present", "canvas.hide", "canvas.navigate"];
const A2UI_V08_BUNDLE_PATH = "/__openclaw__/a2ui/a2ui.bundle.js";
const A2UI_V09_BUNDLE_PATH = "/__openclaw__/a2ui/a2ui-v0.9.bundle.js";
const A2UI_V08_ACTION_KEYS = [
  "beginRendering",
  "surfaceUpdate",
  "dataModelUpdate",
  "deleteSurface",
] as const;
const A2UI_V09_ACTION_KEYS = [
  "createSurface",
  "updateComponents",
  "updateDataModel",
  "deleteSurface",
] as const;

function validateSupportedA2UIJsonl(jsonl: string) {
  const lines = jsonl.split(/\r?\n/);
  const errors: string[] = [];
  let sawV08 = false;
  let sawV09 = false;
  const messages: unknown[] = [];

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed) as unknown;
    } catch (err) {
      errors.push(`line ${idx + 1}: ${String(err)}`);
      return;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      errors.push(`line ${idx + 1}: expected JSON object`);
      return;
    }
    const record = obj as Record<string, unknown>;
    const explicitVersion = record.version;
    // Bundled v0.8 is strict and unversioned; v0.9 identifies every message.
    if (explicitVersion === "v0.8") {
      errors.push(`line ${idx + 1}: A2UI v0.8 messages must not include a version field`);
      return;
    }
    if (explicitVersion !== undefined && explicitVersion !== "v0.9") {
      errors.push(`line ${idx + 1}: unsupported A2UI version: ${JSON.stringify(explicitVersion)}`);
      return;
    }
    const actionKeys = (
      explicitVersion === "v0.9" ? A2UI_V09_ACTION_KEYS : A2UI_V08_ACTION_KEYS
    ).filter((key) => key in record);
    if (actionKeys.length !== 1) {
      errors.push(
        `line ${idx + 1}: expected exactly one ${explicitVersion === "v0.9" ? "v0.9" : "v0.8"} action key`,
      );
      return;
    }
    const allowedTopLevelKeys = new Set(
      explicitVersion === "v0.9" ? ["version", actionKeys[0]] : [actionKeys[0]],
    );
    if (Object.keys(record).some((key) => !allowedTopLevelKeys.has(key))) {
      errors.push(`line ${idx + 1}: unexpected top-level A2UI field`);
      return;
    }
    const payload = record[actionKeys[0]!];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      errors.push(`line ${idx + 1}: action payload must be an object`);
      return;
    }
    if (explicitVersion === "v0.9") {
      const result = A2uiV09MessageSchema.safeParse(record);
      if (!result.success) {
        errors.push(
          `line ${idx + 1}: ${result.error.issues[0]?.message ?? "invalid v0.9 message"}`,
        );
        return;
      }
      sawV09 = true;
    } else {
      sawV08 = true;
    }
    messages.push(record);
  });

  if (messages.length === 0 && errors.length === 0) {
    errors.push("no JSONL messages found");
  }
  if (sawV08 && sawV09) {
    errors.push("mixed A2UI v0.8 and v0.9 messages in one file");
  }
  if (errors.length > 0) {
    throw new Error(`Invalid A2UI JSONL:\n- ${errors.join("\n- ")}`);
  }

  const version: "v0.8" | "v0.9" = sawV09 ? "v0.9" : "v0.8";
  return { version, messages };
}

function createLazyCanvasTool(agentSessionKey?: string): AnyAgentTool {
  const loadTool = createLazyRuntimeModule(() =>
    import("./src/tool.js").then(({ createCanvasTool }) => createCanvasTool({ agentSessionKey })),
  );
  return {
    ...canvasToolDefinition,
    execute: async (...args: Parameters<AnyAgentTool["execute"]>) =>
      await (await loadTool()).execute(...args),
  };
}

export default definePluginEntry({
  id: "canvas",
  name: "Canvas",
  description: "Presents hosted widget documents on paired macOS panels.",
  configSchema: canvasConfigSchema,
  register(api) {
    if (isCanvasHostEnabled(api.config)) {
      api.registerBoardWidgetContentKind({
        kind: "a2ui",
        label: "A2UI",
        resources: {
          surface: "canvas",
          paths: [A2UI_V08_BUNDLE_PATH, A2UI_V09_BUNDLE_PATH],
          readPublicResource: async (resourcePath) => {
            if (resourcePath !== A2UI_V08_BUNDLE_PATH && resourcePath !== A2UI_V09_BUNDLE_PATH) {
              return undefined;
            }
            const { readPublicA2uiResource } = await import("./src/host/a2ui.js");
            return await readPublicA2uiResource(resourcePath);
          },
        },
        validateSource(source) {
          validateSupportedA2UIJsonl(source);
        },
        composeDocument({ source, resourceUrls, promptGranted }) {
          const parsed = validateSupportedA2UIJsonl(source);
          const bundlePath =
            parsed.version === "v0.9" ? A2UI_V09_BUNDLE_PATH : A2UI_V08_BUNDLE_PATH;
          const bundleUrl = resourceUrls[bundlePath];
          if (!bundleUrl) {
            throw new Error(`A2UI renderer resource unavailable: ${bundlePath}`);
          }
          const boot = JSON.stringify({
            messages: parsed.messages,
            actionTier: promptGranted ? "prompt" : "state",
          })
            .replaceAll("<", "\\u003c")
            .replaceAll("\u2028", "\\u2028")
            .replaceAll("\u2029", "\\u2029");
          const rendererScript =
            bundleUrl !== bundlePath
              ? `<script src="${escapeHtml(bundleUrl)}"></script>`
              : `<script>(()=>{const match=location.pathname.match(/^\\/__openclaw__\\/cap\\/[^/]+/u);const script=document.createElement("script");script.src=(match?.[0]??"")+${JSON.stringify(bundlePath).replaceAll("<", "\\u003c")};document.head.appendChild(script);})();</script>`;
          return `<script>globalThis.openclawA2UIBoot=${boot};</script><style>html,body{height:100%;overflow:hidden;background:transparent}openclaw-a2ui-host{display:block;height:100%}</style><openclaw-a2ui-host></openclaw-a2ui-host>${rendererScript}`;
        },
      });
      const loadRenderer = createLazyRuntimeModule(() => import("./src/host/a2ui.js"));
      api.registerHttpRoute({
        path: A2UI_PATH,
        auth: "plugin",
        match: "prefix",
        nodeCapability: { surface: "canvas" },
        handler: async (req, res) => await (await loadRenderer()).handleA2uiHttpRequest(req, res),
      });
      const nodesRuntime = api.runtime.nodes;
      type CanvasRuntimeNode = Awaited<ReturnType<typeof nodesRuntime.list>>["nodes"][number];
      async function selectCanvasNode(): Promise<CanvasRuntimeNode | null> {
        const { selectDefaultNodeFromList } =
          await import("openclaw/plugin-sdk/agent-harness-runtime");
        const { nodes } = await nodesRuntime.list({ connected: true });
        return selectDefaultNodeFromList(nodes.filter(isEligibleCanvasNode), {
          capability: "canvas",
          fallback: "first",
          preferLocalMac: true,
        });
      }

      api.registerWidgetPresenter({
        target: "node_panel",
        description: "Show on a connected device panel",
        async availability() {
          try {
            const node = await selectCanvasNode();
            return node
              ? { ok: true, value: { available: true } }
              : {
                  ok: false,
                  error: {
                    code: "no_eligible_node",
                    message: "No connected canvas-capable device is available.",
                  },
                };
          } catch (error) {
            return {
              ok: false,
              error: { code: "node_error", message: formatErrorMessage(error) },
            };
          }
        },
        async present({ document, context }) {
          if (!document.hostedUrl) {
            return {
              ok: false,
              error: {
                code: "node_error",
                message: "The widget document is not hosted for device presentation.",
              },
            };
          }
          let node: CanvasRuntimeNode | null;
          try {
            node = await selectCanvasNode();
          } catch (error) {
            return {
              ok: false,
              error: { code: "node_error", message: formatErrorMessage(error) },
            };
          }
          if (!node) {
            return {
              ok: false,
              error: {
                code: "no_eligible_node",
                message: "No connected canvas-capable device is available.",
              },
            };
          }
          try {
            await nodesRuntime.invoke({
              nodeId: node.nodeId,
              command: CANVAS_PRESENT_COMMAND,
              params: { url: document.hostedUrl },
              timeoutMs: DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS,
              idempotencyKey: randomUUID(),
              ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
            });
            return {
              ok: true,
              value: {
                kind: "node",
                nodeId: node.nodeId,
                ...(node.displayName ? { nodeName: node.displayName } : {}),
              },
            };
          } catch (error) {
            return {
              ok: false,
              error: {
                code: "node_error",
                message: formatErrorMessage(error),
                nodeId: node.nodeId,
              },
            };
          }
        },
      });
    }
    api.registerNodeInvokePolicy({
      commands: CANVAS_NODE_COMMANDS,
      defaultPlatforms: ["macos"],
      handle: async (ctx) => await ctx.invokeNode(),
    });
    api.registerTool((ctx) => createLazyCanvasTool(ctx.sessionKey));
    api.registerNodeCliFeature(
      async ({ program }) => {
        const { registerNodesCanvasCommands } = await import("./src/cli.js");
        registerNodesCanvasCommands(program);
      },
      {
        descriptors: [
          {
            name: "canvas",
            description: "Present widget documents on a paired macOS panel",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
