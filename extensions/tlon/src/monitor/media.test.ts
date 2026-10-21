import { MAX_IMAGE_BYTES, saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTlonInboundMediaPrompt, downloadMessageImages } from "./media.js";

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MAX_IMAGE_BYTES: 6 * 1024 * 1024,
  saveRemoteMedia: vi.fn(),
}));

const saveRemoteMediaMock = vi.mocked(saveRemoteMedia);
const photoUrl = "https://example.com/photo.png";
const imageBlock = (src: string) => ({ block: { image: { src } } });
const savedImage = {
  id: "photo---uuid.png",
  path: "/tmp/openclaw/media/inbound/photo---uuid.png",
  size: 10,
  contentType: "image/png",
};

describe("tlon monitor media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("caps downloaded images at eight per message", async () => {
    const content = Array.from({ length: 10 }, (_, index) =>
      imageBlock(`https://example.com/${index}.png`),
    );
    saveRemoteMediaMock.mockImplementation(async ({ url }) => ({
      ...savedImage,
      id: `photo-${url}.png`,
      path: `/tmp/openclaw/media/inbound/${url.split("/").pop()}`,
    }));

    const result = await downloadMessageImages(content);

    expect([result.unavailableCount, result.attachments.length]).toEqual([2, 8]);
    expect(saveRemoteMediaMock.mock.calls.map(([options]) => options.url)).toEqual(
      Array.from({ length: 8 }, (_, index) => `https://example.com/${index}.png`),
    );
  });

  it("keeps the duplicated path projection byte-stable beside ordered facts", () => {
    const media = [
      { path: "/tmp/a.png", contentType: "image/png" },
      { path: "/tmp/b.jpg", contentType: "image/jpeg" },
    ];
    expect(buildTlonInboundMediaPrompt("caption", media)).toEqual({
      body: [
        "[media attached: /tmp/a.png (image/png) | /tmp/a.png]",
        "[media attached: /tmp/b.jpg (image/jpeg) | /tmp/b.jpg]",
        "caption",
      ].join("\n"),
      media: [
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.jpg", contentType: "image/jpeg" },
      ],
    });
  });

  it.each([
    [undefined, MAX_IMAGE_BYTES],
    [1024, 1024],
    [MAX_IMAGE_BYTES * 2, MAX_IMAGE_BYTES],
  ])("stores fetched media with cap %s as %s bytes", async (maxBytes, expectedMaxBytes) => {
    saveRemoteMediaMock.mockResolvedValue(savedImage);
    const result = await downloadMessageImages([imageBlock(photoUrl)], maxBytes);

    expect(saveRemoteMediaMock).toHaveBeenCalledTimes(1);
    expect(saveRemoteMediaMock).toHaveBeenCalledWith({
      url: photoUrl,
      maxBytes: expectedMaxBytes,
      responseHeaderTimeoutMs: 120_000,
      readIdleTimeoutMs: 30_000,
      ssrfPolicy: undefined,
      requestInit: { method: "GET" },
    });
    expect(result).toEqual({
      attachments: [{ path: savedImage.path, contentType: savedImage.contentType }],
      unavailableCount: 0,
    });
  });

  it("reports an unavailable image when the fetch exceeds the image cap", async () => {
    saveRemoteMediaMock.mockRejectedValue(
      new Error(
        `Failed to fetch media from ${photoUrl}: payload exceeds maxBytes ${MAX_IMAGE_BYTES}`,
      ),
    );

    expect(await downloadMessageImages([imageBlock(photoUrl)])).toEqual({
      attachments: [],
      unavailableCount: 1,
    });
    expect(console.error).toHaveBeenCalledWith("[tlon-media] Error downloading inbound media");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(photoUrl);
  });

  it("rejects non-http media without logging its contents", async () => {
    const url = "data:image/png;base64,private-inbound-image";
    expect(await downloadMessageImages([imageBlock(url)])).toEqual({
      attachments: [],
      unavailableCount: 1,
    });
    expect(saveRemoteMediaMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[tlon-media] Rejected non-http(s) media URL");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(url);
  });
});
