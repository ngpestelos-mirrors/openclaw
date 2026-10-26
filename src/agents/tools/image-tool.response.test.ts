import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as llmStream from "../../llm/stream.js";
import * as imageModelRuntime from "../../media-understanding/image-model-runtime.js";
import * as modelNormalization from "../../plugins/manifest-model-id-normalization.js";
import * as providerStream from "../provider-stream.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createRequiredImageTool, ONE_PIXEL_PNG_B64, testing } from "./image-tool.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Message = NonNullable<Parameters<typeof makeAssistantMessageFixture>[0]>;
const response = (content: Message["content"], overrides: Message = {}) =>
  makeAssistantMessageFixture({
    stopReason: "stop",
    errorMessage: undefined,
    content,
    ...overrides,
  });
const reasoning = (): Message["content"] => [
  { type: "thinking", thinking: "", thinkingSignature: "reasoning_content" },
];

describe("image tool response validation", () => {
  beforeEach(() => {
    testing.setProviderDepsForTest({
      buildProviderRegistry: () => new Map(),
      getMediaUnderstandingProvider: () => undefined,
      resolveRegisteredMediaUnderstandingProvider: () => undefined,
      resolveImageCompressionPolicy: async ({ imageCount }) => ({ imageCount }),
      loadImageWebMediaRuntime: async () => ({
        loadWebMedia: async () => {
          throw new Error("Expected an inline image fixture");
        },
        optimizeImageBufferForWebMedia: async ({ buffer, contentType }) => ({
          buffer,
          contentType,
          kind: "image",
        }),
      }),
    });
    vi.spyOn(modelNormalization, "resolveManifestModelIdNormalizationPolicies").mockReturnValue(
      new Map(),
    );
    vi.spyOn(imageModelRuntime, "resolveImageRuntime").mockImplementation(async (params) => ({
      runtimeValue: "test-key",
      model: makeProviderModelFixture({
        id: "gpt-5.4-mini",
        provider: "openai",
        api: "openai-responses",
        input: ["text", "image"],
        baseUrl: "https://image-fixture.invalid/v1",
      }),
      cfg: params.cfg,
      agentDir: params.agentDir,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    }));
    vi.spyOn(providerStream, "registerProviderStreamForModel").mockReturnValue(undefined);
    vi.spyOn(llmStream, "complete");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testing.setProviderDepsForTest();
  });

  async function executeImage() {
    const tool = createRequiredImageTool({
      agentDir: tempDirs.make("openclaw-image-response-"),
      config: { agents: { defaults: { imageModel: { primary: "openai/gpt-5.4-mini" } } } },
    });
    return await tool.execute("image", { path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}` });
  }

  it.each([
    [
      response([{ type: "thinking", thinking: "hmm" }]),
      "Image model returned no text (openai/gpt-5.4-mini).",
    ],
    [
      response([{ type: "text", text: "must not hide the failure" }], { errorMessage: "  boom  " }),
      "Image model failed (openai/gpt-5.4-mini): boom",
    ],
    ...(["error", "aborted"] as const).map(
      (stopReason) =>
        [
          response(reasoning(), { stopReason }),
          "Image model failed (openai/gpt-5.4-mini)",
        ] as const,
    ),
  ] as const)("rejects invalid image response %# without retry", async (message, expectedError) => {
    vi.mocked(llmStream.complete).mockResolvedValue(message);
    await expect(executeImage()).rejects.toThrow(expectedError);
    expect(llmStream.complete).toHaveBeenCalledOnce();
  });

  it("returns trimmed image text after a reasoning-only retry", async () => {
    vi.mocked(llmStream.complete)
      .mockResolvedValueOnce(response(reasoning()))
      .mockResolvedValueOnce(
        response([{ type: "text", text: "  hello  " }], {
          stopReason: "length",
          errorMessage: "  ",
        }),
      );
    const result = await executeImage();
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.details).toMatchObject({ model: "openai/gpt-5.4-mini", text: "hello" });
    expect(llmStream.complete).toHaveBeenCalledTimes(2);
  });
});
