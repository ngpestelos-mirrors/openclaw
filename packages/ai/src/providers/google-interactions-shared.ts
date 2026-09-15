/**
 * Gemini Interactions API adapter and lifecycle for OpenClaw.
 * POST /v1beta/interactions
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import { calculateCost } from "../model-utils.js";
import {
  assignTransportErrorDetails,
  notifyProviderStreamOpened,
  transportAbortError,
} from "../transports/transport-stream-shared.js";
import type {
  AssistantMessage,
  Context,
  Model,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import type { GoogleApiType, GoogleProviderOptions } from "./google-shared.js";

export type { GoogleApiType };

export const DEFAULT_GOOGLE_API_BASE_URL = "https://generativelanguage.googleapis.com";

let packageVersionMemo: string | undefined;

function resolvePackageVersion(): string {
  if (packageVersionMemo) {
    return packageVersionMemo;
  }
  if (typeof process !== "undefined" && process.env?.OPENCLAW_VERSION) {
    packageVersionMemo = process.env.OPENCLAW_VERSION;
    return packageVersionMemo;
  }
  try {
    const require = createRequire(import.meta.url);
    const candidates = [
      "../package.json",
      "../../package.json",
      "../../../package.json",
      "../../../../package.json",
    ];
    for (const candidate of candidates) {
      try {
        const parsed = require(candidate) as { name?: string; version?: string };
        if (parsed?.version && (parsed.name === "openclaw" || parsed.name === "@openclaw/ai")) {
          packageVersionMemo = parsed.version;
          return packageVersionMemo;
        }
      } catch {
        // next candidate
      }
    }
  } catch {
    // fallback
  }
  packageVersionMemo = "0.0";
  return packageVersionMemo;
}

export function resolveGoogleApiClientHeaders(params?: {
  api?: string;
  baseUrl?: string;
  capability?: string;
  transport?: string;
  model?: Model;
}): Record<string, string> {
  const hostHeaders = getAiTransportHost().resolveProviderRequestHeaders({
    provider: "google",
    api: params?.api ?? params?.model?.api ?? "google-generative-ai",
    baseUrl: params?.baseUrl ?? DEFAULT_GOOGLE_API_BASE_URL,
    model: params?.model,
  });
  if (hostHeaders?.["x-goog-api-client"]) {
    return hostHeaders;
  }
  const version = resolvePackageVersion();
  return {
    ...hostHeaders,
    "x-goog-api-client": `openclaw/${version}`,
  };
}

export type GoogleInteractionsStep =
  | {
      type: "user_input";
      content: Array<
        { type: "text"; text: string } | { type: "image"; mime_type: string; data: string }
      >;
    }
  | {
      type: "thought";
      signature?: string;
      summary?: Array<{ type: "text"; text: string }>;
    }
  | {
      type: "model_output";
      content: Array<{ type: "text"; text: string }>;
    }
  | {
      type: "function_call";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "function_result";
      call_id: string;
      name: string;
      result: unknown;
    };

export type GoogleInteractionsRequestBody = {
  model: string;
  input: GoogleInteractionsStep[];
  system_instruction?: string;
  tools?: Array<{
    type: "function";
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  generation_config?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    max_output_tokens?: number;
    stop_sequences?: string[];
    thinking_level?: string;
    thinking_summaries?: "auto" | "none";
  };
  store: boolean;
  stream: boolean;
};

export function buildGoogleInteractionsParams<T extends GoogleApiType>(
  model: Model<T>,
  context: Context,
  options: GoogleProviderOptions = {},
): GoogleInteractionsRequestBody {
  // Reject unsupported parameters locally with clear errors
  if (
    (options as Record<string, unknown>).cachedContent ||
    (options as Record<string, unknown>).cached_content
  ) {
    throw new Error(
      "Explicit prompt caching ('cachedContent') is not supported with the Gemini Interactions API. The Interactions API handles caching implicitly on the server.",
    );
  }
  if (
    (options as Record<string, unknown>).videoMetadata ||
    (options as Record<string, unknown>).video_metadata
  ) {
    throw new Error(
      "video_metadata clipping offsets are not supported with the Gemini Interactions API.",
    );
  }

  const steps: GoogleInteractionsStep[] = [];

  for (const msg of context.messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        steps.push({
          type: "user_input",
          content: [{ type: "text", text: sanitizeSurrogates(msg.content) || " " }],
        });
      } else {
        const content: Array<
          { type: "text"; text: string } | { type: "image"; mime_type: string; data: string }
        > = [];
        for (const item of msg.content) {
          if (item.type === "text") {
            content.push({ type: "text", text: sanitizeSurrogates(item.text) || " " });
          } else if (item.type === "image" && item.mimeType && item.data) {
            content.push({ type: "image", mime_type: item.mimeType, data: item.data });
          }
        }
        if (content.length === 0) {
          content.push({ type: "text", text: " " });
        }
        steps.push({ type: "user_input", content });
      }
    } else if (msg.role === "assistant") {
      if ((msg as AssistantMessage).stopReason === "error") {
        continue;
      }
      const isFailedPlaceholder =
        Array.isArray(msg.content) &&
        msg.content.length === 1 &&
        msg.content[0]?.type === "text" &&
        msg.content[0]?.text?.includes("[assistant turn failed before producing content]");
      if (isFailedPlaceholder) {
        continue;
      }

      let pendingTextParts: string[] = [];
      const flushText = () => {
        if (pendingTextParts.length > 0) {
          steps.push({
            type: "model_output",
            content: [{ type: "text", text: pendingTextParts.join("\n\n") }],
          });
          pendingTextParts = [];
        }
      };

      for (const block of msg.content) {
        if (block.type === "thinking") {
          flushText();
          const signature =
            block.thinkingSignature || (block as { thoughtSignature?: string }).thoughtSignature;
          if (signature) {
            steps.push({
              type: "thought",
              signature,
              ...(block.thinking && block.thinking.trim()
                ? { summary: [{ type: "text", text: sanitizeSurrogates(block.thinking) }] }
                : {}),
            });
          }
        } else if (block.type === "text") {
          if (block.text && block.text.trim()) {
            pendingTextParts.push(sanitizeSurrogates(block.text));
          }
        } else if (block.type === "toolCall") {
          flushText();
          // In the Interactions API, thoughts are dedicated "thought" steps and signatures
          // are restricted exclusively to thought steps and built-in tools. They never appear
          // on standard function calls. If a toolCall has a thoughtSignature from an external or legacy session
          // and no dedicated thinking block was present in this message, emit it as a separate thought step.
          if (
            block.thoughtSignature &&
            block.thoughtSignature !== "skip_thought_signature_validator" &&
            !msg.content.some((b) => b.type === "thinking")
          ) {
            steps.push({
              type: "thought",
              signature: block.thoughtSignature,
            });
          }
          steps.push({
            type: "function_call",
            id: block.id,
            name: block.name,
            arguments: (block.arguments as Record<string, unknown>) ?? {},
          });
        }
      }

      flushText();
    } else if (msg.role === "toolResult") {
      steps.push({
        type: "function_result",
        call_id: msg.toolCallId,
        name: msg.toolName || "tool",
        result: msg.content,
      });
    }
  }

  // Ensure that within any contiguous model turn (between user_input / function_result),
  // all 'thought' steps appear before 'model_output' or 'function_call' steps.
  const normalizedSteps: GoogleInteractionsStep[] = [];
  let currentModelSegment: GoogleInteractionsStep[] = [];
  const flushModelSegment = () => {
    if (currentModelSegment.length > 0) {
      const thoughts = currentModelSegment.filter((s) => s.type === "thought");
      const others = currentModelSegment.filter((s) => s.type !== "thought");
      normalizedSteps.push(...thoughts, ...others);
      currentModelSegment = [];
    }
  };
  for (const step of steps) {
    if (step.type === "user_input" || step.type === "function_result") {
      flushModelSegment();
      normalizedSteps.push(step);
    } else {
      currentModelSegment.push(step);
    }
  }
  flushModelSegment();

  const generation_config: GoogleInteractionsRequestBody["generation_config"] = {};
  if (options.temperature !== undefined) {
    generation_config.temperature = options.temperature;
  }
  if (options.maxTokens !== undefined) {
    generation_config.max_output_tokens = options.maxTokens;
  }
  if (options.stop !== undefined && options.stop.length > 0) {
    generation_config.stop_sequences = options.stop;
  }
  if (options.thinking?.enabled) {
    generation_config.thinking_summaries = "auto";
    if (options.thinking.level) {
      generation_config.thinking_level = options.thinking.level.toLowerCase();
    } else {
      generation_config.thinking_level = "high";
    }
  }

  let tools: GoogleInteractionsRequestBody["tools"] | undefined;
  if (context.tools && context.tools.length > 0) {
    tools = context.tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description || "",
      parameters: (t.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));
  }

  const body: GoogleInteractionsRequestBody = {
    model: model.id,
    input: normalizedSteps,
    store: false,
    stream: true,
  };

  if (context.systemPrompt) {
    body.system_instruction = sanitizeSurrogates(
      stripSystemPromptCacheBoundary(context.systemPrompt),
    );
  }
  if (tools && tools.length > 0) {
    body.tools = tools;
  }
  if (Object.keys(generation_config).length > 0) {
    body.generation_config = generation_config;
  }

  return body;
}

function logGoogleInteractionsHttp(entry: Record<string, unknown>): void {
  if (process.env.OPENCLAW_LOG_HTTP !== "1" && process.env.OPENCLAW_LOG_HTTP !== "true") {
    return;
  }
  try {
    const logPath =
      process.env.OPENCLAW_LOG_HTTP_PATH?.trim() ||
      path.join(os.homedir(), ".openclaw", "logs", "google-interactions-http.jsonl");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // Best-effort diagnostic logging; ignore file system errors.
  }
}

export async function runGoogleInteractionsLifecycle<T extends GoogleApiType>(params: {
  stream: AssistantMessageEventStream;
  model: Model<T>;
  output: AssistantMessage;
  options?: GoogleProviderOptions;
  context: Context;
  nextToolCallId: (name: string) => string;
  apiKey?: string;
}): Promise<void> {
  const { stream, model, output, options, context, nextToolCallId } = params;

  try {
    const apiKey =
      params.apiKey ||
      options?.apiKey ||
      getEnvApiKey(model.provider) ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      "";
    let body = buildGoogleInteractionsParams(model, context, options);
    const nextBody = await options?.onPayload?.(body, model);
    if (nextBody !== undefined && nextBody !== null && typeof nextBody === "object") {
      body = nextBody as GoogleInteractionsParams;
    }

    let baseUrl = (model.baseUrl || "https://generativelanguage.googleapis.com/v1beta")
      .trim()
      .replace(/\/+$/, "");
    if (/^https:\/\/generativelanguage\.googleapis\.com$/i.test(baseUrl)) {
      baseUrl = "https://generativelanguage.googleapis.com/v1beta";
    }
    const url = `${baseUrl}/interactions?alt=sse`;

    const googleClientHeaders = resolveGoogleApiClientHeaders({
      baseUrl,
      api: "google-generative-ai",
      model: model as Model,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
      "Api-Revision": "2026-05-20",
      ...googleClientHeaders,
      ...model.headers,
      ...options?.headers,
    };

    const redactedHeaders = { ...headers };
    if (redactedHeaders["x-goog-api-key"]) {
      const key = redactedHeaders["x-goog-api-key"];
      redactedHeaders["x-goog-api-key"] =
        key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "***";
    }

    logGoogleInteractionsHttp({
      event: "http_request",
      method: "POST",
      url,
      headers: redactedHeaders,
      body,
    });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    logGoogleInteractionsHttp({
      event: "http_response",
      status: response.status,
      statusText: response.statusText,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logGoogleInteractionsHttp({
        event: "http_error",
        status: response.status,
        errorText,
      });
      throw new Error(`Google Interactions API error HTTP ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error("Google Interactions API returned empty response body");
    }

    const reader = response.body.getReader();
    await notifyProviderStreamOpened({
      options,
      cancelStream: async () => {
        await reader.cancel();
      },
    });
    const decoder = new TextDecoder();
    let buffer = "";

    let currentBlockType: "text" | "thinking" | "toolCall" | null = null;
    let currentBlockIndex = -1;
    let currentToolCall: ToolCall | null = null;
    let currentToolArgs = "";
    let latestThoughtSignature: string | undefined;

    const endCurrentBlock = () => {
      if (currentBlockType === "text") {
        const textBlock = output.content[currentBlockIndex] as TextContent | undefined;
        stream.push({
          type: "text_end",
          contentIndex: currentBlockIndex,
          content: textBlock?.text ?? "",
          partial: output,
        });
      } else if (currentBlockType === "thinking") {
        const thinkingBlock = output.content[currentBlockIndex] as ThinkingContent | undefined;
        if (thinkingBlock && !thinkingBlock.thinkingSignature && latestThoughtSignature) {
          thinkingBlock.thinkingSignature = latestThoughtSignature;
        }
        stream.push({
          type: "thinking_end",
          contentIndex: currentBlockIndex,
          content: thinkingBlock?.thinking ?? "",
          partial: output,
        });
        latestThoughtSignature = undefined;
      } else if (currentBlockType === "toolCall" && currentToolCall) {
        if (currentToolArgs.trim()) {
          try {
            currentToolCall.arguments = JSON.parse(currentToolArgs);
          } catch {
            currentToolCall.arguments = { raw: currentToolArgs };
          }
        }
        stream.push({
          type: "toolcall_end",
          contentIndex: currentBlockIndex,
          toolCall: currentToolCall,
          partial: output,
        });
        currentToolCall = null;
        currentToolArgs = "";
      }
      currentBlockType = null;
    };

    let streamDone = false;
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) {
          continue;
        }
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") {
          streamDone = true;
          break;
        }

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(dataStr);
        } catch {
          continue;
        }

        logGoogleInteractionsHttp({
          event: "sse_event",
          data: event,
        });

        const eventType = event.event_type || event.type;

        if (eventType === "step.delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          const deltaType = delta?.type;

          if (deltaType === "text") {
            const text = String(delta?.text ?? "");
            if (text) {
              if (currentBlockType !== "text") {
                endCurrentBlock();
                currentBlockType = "text";
                currentBlockIndex = output.content.length;
                output.content.push({ type: "text", text: "" });
                stream.push({
                  type: "text_start",
                  contentIndex: currentBlockIndex,
                  partial: output,
                });
              }
              const block = output.content[currentBlockIndex] as { type: "text"; text: string };
              block.text += text;
              stream.push({
                type: "text_delta",
                contentIndex: currentBlockIndex,
                delta: text,
                partial: output,
              });
            }
          } else if (
            deltaType === "thought" ||
            deltaType === "thought_summary" ||
            deltaType === "raw_thought"
          ) {
            let thinkingText = "";
            if (typeof delta?.text === "string") {
              thinkingText = delta.text;
            } else if (typeof delta?.content === "string") {
              thinkingText = delta.content;
            } else if (delta?.content && typeof delta.content === "object") {
              if (typeof (delta.content as { text?: string }).text === "string") {
                thinkingText = (delta.content as { text: string }).text;
              } else if (Array.isArray(delta.content)) {
                thinkingText = (delta.content as Array<{ text?: string }>)
                  .map((c) => c?.text ?? "")
                  .join("");
              }
            }
            if (thinkingText) {
              if (currentBlockType !== "thinking") {
                endCurrentBlock();
                currentBlockType = "thinking";
                currentBlockIndex = output.content.length;
                output.content.push({
                  type: "thinking",
                  thinking: "",
                  ...(latestThoughtSignature ? { thinkingSignature: latestThoughtSignature } : {}),
                });
                stream.push({
                  type: "thinking_start",
                  contentIndex: currentBlockIndex,
                  partial: output,
                });
              }
              const block = output.content[currentBlockIndex] as {
                type: "thinking";
                thinking: string;
              };
              block.thinking += thinkingText;
              stream.push({
                type: "thinking_delta",
                contentIndex: currentBlockIndex,
                delta: thinkingText,
                partial: output,
              });
            }
          } else if (
            deltaType === "thought_signature" ||
            (delta && typeof delta.signature === "string" && !delta.text)
          ) {
            const signature = String(delta?.signature ?? "");
            if (signature) {
              latestThoughtSignature = signature;
              if (currentBlockType === "thinking") {
                const block = output.content[currentBlockIndex] as ThinkingContent;
                block.thinkingSignature = signature;
              } else {
                const lastThinking = output.content.findLast((b) => b.type === "thinking") as
                  | ThinkingContent
                  | undefined;
                if (lastThinking && !lastThinking.thinkingSignature) {
                  lastThinking.thinkingSignature = signature;
                } else if (!lastThinking) {
                  output.content.push({
                    type: "thinking",
                    thinking: "",
                    thinkingSignature: signature,
                  });
                }
              }
            }
          } else if (deltaType === "arguments" || deltaType === "arguments_delta") {
            const argText = String(delta?.arguments ?? delta?.text ?? "");
            if (currentBlockType !== "toolCall") {
              endCurrentBlock();
              currentBlockType = "toolCall";
              currentBlockIndex = output.content.length;
              const toolName = String(delta?.name ?? "tool");
              const toolCallId = String(delta?.id ?? nextToolCallId(toolName));
              currentToolCall = {
                type: "toolCall",
                id: toolCallId,
                name: toolName,
                arguments: {},
              };
              currentToolArgs = "";
              output.content.push(currentToolCall);
              stream.push({
                type: "toolcall_start",
                contentIndex: currentBlockIndex,
                partial: output,
              });
            }
            if (
              delta?.name &&
              currentToolCall &&
              (!currentToolCall.name || currentToolCall.name === "tool")
            ) {
              currentToolCall.name = String(delta.name);
            }
            if (delta?.id && currentToolCall) {
              currentToolCall.id = String(delta.id);
            }
            currentToolArgs += argText;
            stream.push({
              type: "toolcall_delta",
              contentIndex: currentBlockIndex,
              delta: argText,
              partial: output,
            });
          }
        } else if (eventType === "step.start") {
          const step = event.step as Record<string, unknown> | undefined;
          if (step?.type === "thought") {
            if (step.signature) {
              latestThoughtSignature = String(step.signature);
            }
            let initialThinking = "";
            if (Array.isArray(step.summary)) {
              initialThinking = (step.summary as Array<{ text?: string }>)
                .map((c) => (typeof c?.text === "string" ? c.text : ""))
                .join("");
            }
            if (currentBlockType !== "thinking") {
              endCurrentBlock();
              currentBlockType = "thinking";
              currentBlockIndex = output.content.length;
              output.content.push({
                type: "thinking",
                thinking: initialThinking,
                ...(latestThoughtSignature ? { thinkingSignature: latestThoughtSignature } : {}),
              });
              stream.push({
                type: "thinking_start",
                contentIndex: currentBlockIndex,
                partial: output,
              });
              if (initialThinking) {
                stream.push({
                  type: "thinking_delta",
                  contentIndex: currentBlockIndex,
                  delta: initialThinking,
                  partial: output,
                });
              }
            }
          } else if (step?.type === "function_call") {
            endCurrentBlock();
            currentBlockType = "toolCall";
            currentBlockIndex = output.content.length;
            const toolName = String(step.name ?? "tool");
            const toolCallId = String(step.id ?? nextToolCallId(toolName));
            const stepArgs =
              step.arguments && typeof step.arguments === "object"
                ? (step.arguments as Record<string, unknown>)
                : {};
            const initialArgs = Object.keys(stepArgs).length > 0 ? JSON.stringify(stepArgs) : "";
            currentToolCall = {
              type: "toolCall",
              id: toolCallId,
              name: toolName,
              arguments: stepArgs,
            };
            currentToolArgs = initialArgs;
            output.content.push(currentToolCall);
            stream.push({
              type: "toolcall_start",
              contentIndex: currentBlockIndex,
              partial: output,
            });
          }
        } else if (eventType === "step.stop") {
          endCurrentBlock();
        } else if (eventType === "interaction.completed" || eventType === "interaction.complete") {
          const interaction = (event.interaction as Record<string, unknown>) || event;
          const usage = (interaction.usage as Record<string, unknown>) || {};
          const promptTokens = Number(usage.total_input_tokens ?? 0);
          const candidatesTokens = Number(usage.total_output_tokens ?? 0);
          const totalTokens = Number(usage.total_tokens ?? promptTokens + candidatesTokens);

          output.usage = {
            input: promptTokens,
            output: candidatesTokens,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          if (model.cost) {
            calculateCost(model, output.usage);
          }

          const hasToolCalls = output.content.some((b) => b.type === "toolCall");
          output.stopReason = hasToolCalls ? ("toolUse" as StopReason) : ("stop" as StopReason);
        }
      }
    }

    if (streamDone) {
      void reader.cancel().catch(() => {});
    }

    endCurrentBlock();

    if (latestThoughtSignature) {
      for (const block of output.content) {
        if (block.type === "thinking" && !block.thinkingSignature) {
          block.thinkingSignature = latestThoughtSignature;
        } else if (block.type === "toolCall" && !block.thoughtSignature) {
          block.thoughtSignature = latestThoughtSignature;
        }
      }
    }

    if (!output.stopReason) {
      const hasToolCalls = output.content.some((b) => b.type === "toolCall");
      output.stopReason = hasToolCalls ? ("toolUse" as StopReason) : ("stop" as StopReason);
    }

    if (output.stopReason === "aborted" || output.stopReason === "error") {
      throw new Error("An unknown error occurred");
    }

    stream.push({
      type: "done",
      reason: output.stopReason,
      message: output,
    });
    stream.end();
  } catch (error) {
    const failure = options?.signal?.aborted ? transportAbortError(options.signal) : error;
    assignTransportErrorDetails(output, failure, options?.signal);
    stream.push({
      type: "error",
      reason: output.stopReason === "aborted" ? "aborted" : "error",
      error: output,
    });
    stream.end();
  }
}
