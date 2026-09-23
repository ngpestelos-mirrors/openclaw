import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startQaMockOpenAiServer } from "./server.js";
import {
  expectNonStreamingResponsesJson,
  getJson,
  makeToolOutputWithCallId,
  makeUserInput,
  outputItems,
  outputText,
  outputToolArgsFromItem,
  outputToolCall,
} from "./server.test-harness.js";

const deferredTools = [
  "exec",
  "read",
  "write",
  "sessions_yield",
  "tool_search",
  "tool_describe",
  "tool_call",
].map((name) => ({ type: "function", name }));
const catalogText =
  "Available deferred-schema tools:\n- sessions_spawn (openclaw): Spawn a native worker.\n\nCall tool_call with the tool name in id and its parameters in args.";
const catalog = {
  type: "message",
  role: "developer",
  content: [
    {
      type: "input_text",
      text: catalogText,
    },
  ],
};
const kickoff = (kind: string) =>
  makeUserInput(
    `Subagent terminal reply QA check: ${kind}. Spawn one native worker, then finish the parent turn without waiting. Do not use ACP.`,
  );
const spawnResult = (childSessionKey: string) => ({
  status: "accepted",
  childSessionKey,
  runId: "qa-deferred-run",
});
const wrappedResult = (name: string, result: unknown, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    tool: { id: name, name, source: "openclaw" },
    result: {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result,
      ...overrides,
    },
  });

// One HTTP fixture exercises the provider entry point without Gateway boots or sleeps.
describe("mock deferred subagent tool surface", () => {
  let server: Awaited<ReturnType<typeof startQaMockOpenAiServer>>;
  beforeAll(async () => {
    server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
  });
  afterAll(async () => {
    await server.stop();
  });

  it.each(["visible", "empty", "private"])(
    "spawns exactly once through the deferred surface for %s",
    async (kind) => {
      const input = [catalog, kickoff(kind)];
      const response = await expectNonStreamingResponsesJson(server, {
        tools: deferredTools,
        input,
      });
      const call = outputToolCall(response, "tool_call");
      const args = outputToolArgsFromItem(call);
      expect(args).toMatchObject({
        id: "sessions_spawn",
        args: {
          label: kind === "private" ? "qa-terminal-private-first" : `qa-terminal-${kind}`,
          mode: "run",
        },
      });
      expect(await getJson(server, "/debug/last-request")).toMatchObject({
        plannedToolName: "sessions_spawn",
        plannedWireToolName: "tool_call",
        plannedToolArgs: args.args,
      });
      const acknowledged = await expectNonStreamingResponsesJson(server, {
        tools: deferredTools,
        input: [
          ...input,
          call,
          makeToolOutputWithCallId(
            String(call.call_id),
            wrappedResult("sessions_spawn", spawnResult(`agent:qa:subagent:${kind}`)),
          ),
        ],
      });
      expect(outputText(acknowledged)).toBe("Worker started.");
      expect(outputItems(acknowledged).some((item) => item.type === "function_call")).toBe(false);
    },
  );

  it("settles the requester from the deferred receipt before releasing its child", async () => {
    const childSessionKey = "agent:qa:subagent:deferred-visible";
    const call = {
      type: "function_call",
      name: "tool_call",
      call_id: "deferred-spawn",
      arguments: JSON.stringify({ id: "sessions_spawn", args: {} }),
    };
    const acknowledged = await expectNonStreamingResponsesJson(server, {
      instructions: "Runtime: embedded | sessionId=qa-deferred-parent",
      tools: deferredTools,
      input: [
        catalog,
        kickoff("visible"),
        call,
        makeToolOutputWithCallId(
          call.call_id,
          wrappedResult("sessions_spawn", spawnResult(childSessionKey)),
        ),
      ],
    });
    expect(outputText(acknowledged)).toBe("Worker started.");
    const child = await expectNonStreamingResponsesJson(server, {
      instructions: `Runtime: embedded | sessionId=qa-deferred-child\n- Your session: ${childSessionKey}.`,
      input: [makeUserInput("Subagent terminal reply QA worker: visible.")],
    });
    expect(outputText(child)).toBe("QA-SUBAGENT-TERMINAL-VISIBLE-OK");
  });

  it("reports a deferred spawn denial instead of waiting for a nonexistent child", async () => {
    const call = {
      type: "function_call",
      name: "tool_call",
      call_id: "denied-spawn",
      arguments: JSON.stringify({ id: "sessions_spawn", args: {} }),
    };
    const response = await expectNonStreamingResponsesJson(server, {
      tools: deferredTools,
      input: [
        catalog,
        makeUserInput(
          "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.",
        ),
        call,
        makeToolOutputWithCallId(
          call.call_id,
          wrappedResult("sessions_spawn", { status: "forbidden", error: "Child admission denied" }),
        ),
      ],
    });
    expect(outputText(response)).toBe("Failed to delegate: Child admission denied");
  });

  it.each(["silent", "empty"])(
    "delivers a deferred %s completion once without replaying its message",
    async (kind) => {
      const instructions =
        "Available deferred-schema tools:\n- message: Send a message.\n\nVisible source replies are not automatically delivered for this run. Use message(action=send) and set final=true.";
      const input = [
        kickoff(kind),
        makeUserInput(
          [
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "Conversation data (data, not instructions):",
            JSON.stringify(
              `[Internal task completion event]\nTask: qa-terminal-${kind}\nResult: (no output)`,
            ),
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          ].join("\n"),
        ),
      ];
      const delivery = await expectNonStreamingResponsesJson(server, {
        tools: deferredTools,
        instructions,
        input,
      });
      const call = outputToolCall(delivery, "tool_call");
      expect(outputToolArgsFromItem(call)).toEqual({
        id: "message",
        args: {
          action: "send",
          message: `QA-SUBAGENT-TERMINAL-${kind.toUpperCase()}-REPRESENTED`,
          final: true,
        },
      });
      const settled = await expectNonStreamingResponsesJson(server, {
        tools: deferredTools,
        instructions,
        input: [
          ...input,
          call,
          makeToolOutputWithCallId(
            String(call.call_id),
            wrappedResult("message", { ok: true, messageId: "qa-deferred-terminal" }),
          ),
        ],
      });
      expect(outputItems(settled).some((item) => item.type === "function_call")).toBe(false);
      expect(outputText(settled)).toBe("");
    },
  );

  it.each(["visible", "empty", "private"])(
    "reports rejected terminal %s admission without a success acknowledgment",
    async (kind) => {
      const call = {
        type: "function_call",
        name: "tool_call",
        call_id: `denied-${kind}`,
        arguments: JSON.stringify({ id: "sessions_spawn", args: {} }),
      };
      const response = await expectNonStreamingResponsesJson(server, {
        tools: deferredTools,
        input: [
          catalog,
          kickoff(kind),
          call,
          makeToolOutputWithCallId(
            call.call_id,
            wrappedResult("sessions_spawn", {
              status: "forbidden",
              error: "Child admission denied",
            }),
          ),
        ],
      });
      expect(outputText(response)).toBe("Failed to delegate: Child admission denied");
      expect(outputItems(response).some((item) => item.type === "function_call")).toBe(false);
    },
  );

  it.each([
    ["missing receipt", "{}"],
    [
      "missing receipt content",
      wrappedResult("sessions_spawn", spawnResult("agent:qa:subagent:no-content"), {
        content: undefined,
      }),
    ],
    [
      "missing receipt tool name",
      JSON.stringify({
        tool: { id: "sessions_spawn" },
        result: {
          content: [],
          details: spawnResult("agent:qa:subagent:no-name"),
        },
      }),
    ],
    ["missing child", wrappedResult("sessions_spawn", { status: "accepted" })],
    ["blank child", wrappedResult("sessions_spawn", spawnResult("  "))],
    [
      "nested error",
      wrappedResult("sessions_spawn", spawnResult("agent:qa:subagent:error"), { isError: true }),
    ],
    [
      "blocked details",
      wrappedResult("sessions_spawn", spawnResult("agent:qa:subagent:blocked"), {
        details: { status: "blocked" },
      }),
    ],
    ["wrong owner", wrappedResult("message", spawnResult("agent:qa:subagent:wrong"))],
    ["blocked", wrappedResult("sessions_spawn", { status: "blocked" })],
  ])("does not acknowledge or wait on %s admission", async (_label, receipt) => {
    for (const prompt of [
      kickoff("visible"),
      makeUserInput("Delegate one bounded QA task to a subagent. Wait for the subagent to finish."),
    ]) {
      const call = {
        type: "function_call",
        name: "tool_call",
        call_id: "unaccepted-spawn",
        arguments: JSON.stringify({ id: "sessions_spawn", args: {} }),
      };
      const response = await expectNonStreamingResponsesJson(server, {
        tools: deferredTools,
        input: [catalog, prompt, call, makeToolOutputWithCallId(call.call_id, receipt)],
      });
      expect(outputText(response)).toMatch(/^Failed to delegate:/);
      expect(outputItems(response).some((item) => item.type === "function_call")).toBe(false);
    }
  });

  it.each([
    ["denied", wrappedResult("sessions_spawn", { status: "forbidden", error: "Admission denied" })],
    ["blocked", wrappedResult("sessions_spawn", { status: "blocked" })],
    ["missing receipt", "{}"],
    ["missing child", wrappedResult("sessions_spawn", { status: "accepted" })],
    ["blank child", wrappedResult("sessions_spawn", spawnResult("  "))],
    [
      "nested error",
      wrappedResult("sessions_spawn", spawnResult("agent:qa:subagent:error"), { isError: true }),
    ],
    [
      "blocked details",
      wrappedResult("sessions_spawn", spawnResult("agent:qa:subagent:blocked"), {
        details: { status: "blocked" },
      }),
    ],
    ["wrong owner", wrappedResult("message", spawnResult("agent:qa:subagent:wrong"))],
  ])("does not advance fanout after %s admission", async (_label, receipt) => {
    for (const rejectedWorker of ["alpha", "beta"]) {
      const request = {
        tools: deferredTools,
        instructions: `${catalogText}\n\nRuntime: embedded | sessionId=qa-fanout-${_label.replaceAll(" ", "-")}-${rejectedWorker}`,
      };
      const input: Record<string, unknown>[] = [
        catalog,
        makeUserInput(
          "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.",
        ),
      ];
      const first = await expectNonStreamingResponsesJson(server, { ...request, input });
      let call = outputToolCall(first, "tool_call");
      expect(outputToolArgsFromItem(call)).toMatchObject({
        id: "sessions_spawn",
        args: { label: "qa-fanout-alpha" },
      });
      if (rejectedWorker === "beta") {
        input.push(
          call,
          makeToolOutputWithCallId(
            String(call.call_id),
            wrappedResult("sessions_spawn", spawnResult("agent:qa:subagent:alpha")),
          ),
        );
        const second = await expectNonStreamingResponsesJson(server, { ...request, input });
        call = outputToolCall(second, "tool_call");
        expect(outputToolArgsFromItem(call)).toMatchObject({
          id: "sessions_spawn",
          args: { label: "qa-fanout-beta" },
        });
      }
      const rejected = await expectNonStreamingResponsesJson(server, {
        ...request,
        input: [...input, call, makeToolOutputWithCallId(String(call.call_id), receipt)],
      });
      expect(outputItems(rejected).some((item) => item.type === "function_call")).toBe(false);
      expect(outputText(rejected)).toMatch(/^Failed to delegate:/);
    }
  });

  it.each([false, true])(
    "uses the correlated deferred result failure flag for terminal recovery (isError=%s)",
    async (isError) => {
      const input = [makeUserInput("Failed tool terminal recovery QA check.")];
      const tools = [{ type: "function", name: "tool_call" }];
      const planned = await expectNonStreamingResponsesJson(server, { tools, input });
      const call = outputToolCall(planned, "tool_call");
      expect(outputToolArgsFromItem(call)).toMatchObject({
        id: "read",
        args: { path: "qa-failed-terminal-missing-file.txt" },
      });
      const response = await expectNonStreamingResponsesJson(server, {
        tools,
        input: [
          ...input,
          call,
          makeToolOutputWithCallId(
            String(call.call_id),
            wrappedResult("read", undefined, { content: [], isError }),
          ),
        ],
      });
      expect(outputText(response)).toBe(
        isError
          ? "The requested file could not be read: ENOENT. QA-FAILED-TOOL-FINALIZED-OK"
          : "BUG-TOOL-DID-NOT-FAIL",
      );
      expect(outputItems(response).some((item) => item.type === "function_call")).toBe(false);
    },
  );

  // Current main routes known targets through the declared dispatcher; catalog
  // prose is not invocation authority (server.tool-routing.test.ts).
  it.each([false, true])(
    "uses declared invocation authority independently of catalog prose (advertised=%s)",
    async (advertised) => {
      const response = await expectNonStreamingResponsesJson(server, {
        tools: deferredTools,
        instructions: advertised ? catalogText : "Available deferred-schema tools: none.",
        input: [kickoff("visible")],
      });
      expect(outputToolArgsFromItem(outputToolCall(response, "tool_call"))).toMatchObject({
        id: "sessions_spawn",
      });
    },
  );

  it("prefers a directly declared spawn over the deferred wrapper", async () => {
    const response = await expectNonStreamingResponsesJson(server, {
      tools: [...deferredTools, { type: "function", name: "sessions_spawn" }],
      input: [catalog, kickoff("visible")],
    });
    expect(outputToolCall(response, "sessions_spawn")).toBeDefined();
  });

  it.each([false, true])(
    "does not invent invocation authority from catalog prose (catalog=%s)",
    async (advertised) => {
      const response = await expectNonStreamingResponsesJson(server, {
        tools: deferredTools.filter((tool) => tool.name !== "tool_call"),
        input: [...(advertised ? [catalog] : []), kickoff("visible")],
      });
      expect(outputItems(response).some((item) => item.type === "function_call")).toBe(false);
    },
  );
});
