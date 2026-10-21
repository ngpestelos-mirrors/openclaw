import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSearxngSearch } from "./searxng-client.js";

installPinnedHostnameTestHooks();
afterEach(() => vi.restoreAllMocks());

function search(params: Partial<Parameters<typeof runSearxngSearch>[0]> = {}) {
  return runSearxngSearch({
    baseUrl: "http://127.0.0.1:8888",
    query: "openclaw",
    cacheTtlMinutes: 0,
    ...params,
  });
}

function mockFetch(...bodies: (Response | unknown[])[]) {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const body of bodies) {
    fetch.mockResolvedValueOnce(body instanceof Response ? body : Response.json({ results: body }));
  }
  return fetch;
}

function expectRequests(fetch: ReturnType<typeof mockFetch>, ...urls: string[]) {
  expect(fetch.mock.calls).toEqual(urls.map((url) => [url, expect.anything()]));
}

describe("searxng client", () => {
  it("builds the request URL from plugin config", async () => {
    const fetch = mockFetch([]);
    const webSearch = {
      baseUrl: "http://127.0.0.1:8888/search/",
      categories: "general,news",
      language: "en",
    };
    await runSearxngSearch({
      query: "openclaw",
      cacheTtlMinutes: 0,
      config: { plugins: { entries: { searxng: { config: { webSearch } } } } },
    });

    expectRequests(
      fetch,
      "http://127.0.0.1:8888/search?q=openclaw&format=json&categories=general%2Cnews&language=en",
    );
  });

  it("normalizes, filters, and caps provider result rows", async () => {
    mockFetch([
      {
        title: "Kitten",
        url: "https://example.com/kitten",
        content: "A cute kitten",
        img_src: "https://cdn.example.com/kitten.jpg",
      },
      { title: { text: "bad" }, url: "https://example.com/bad-title" },
      { title: "bad URL", url: 3 },
      { title: "No snippet", url: "https://example.com/text", content: { text: "bad" } },
      { title: "Capped", url: "https://example.com/capped" },
    ]);

    expect(await search({ query: "kittens", count: 2 })).toMatchObject({
      count: 2,
      results: [
        {
          url: "https://example.com/kitten",
          title: expect.stringContaining("Kitten"),
          snippet: expect.stringContaining("A cute kitten"),
          img_src: "https://cdn.example.com/kitten.jpg",
          siteName: "example.com",
        },
        { url: "https://example.com/text" },
      ],
    });
  });

  it("retries an empty category search with general results", async () => {
    const fetch = mockFetch([], [{ title: "Weather", url: "https://example.com/weather" }]);
    const result = await search({ categories: "weather,news" });

    expectRequests(
      fetch,
      "http://127.0.0.1:8888/search?q=openclaw&format=json&categories=weather%2Cnews",
      "http://127.0.0.1:8888/search?q=openclaw&format=json&categories=general",
    );
    expect(result).toMatchObject({
      count: 1,
      results: [{ url: "https://example.com/weather" }],
    });
  });

  it("preserves the upstream HTTP error status", async () => {
    mockFetch(new Response("upstream rejected search", { status: 429 }));
    await expect(search()).rejects.toMatchObject({ status: 429, statusCode: 429 });
  });

  it("rejects invalid and incomplete response bodies", async () => {
    const fetch = mockFetch(new Response("{"));
    await expect(search({ query: "invalid" })).rejects.toThrow("SearXNG returned invalid JSON.");

    const chunk = new TextEncoder().encode("partial");
    let sentChunk = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentChunk) {
          sentChunk = true;
          controller.enqueue(chunk);
          return;
        }
        controller.error(new Error("stream reset"));
      },
    });
    fetch.mockResolvedValueOnce(new Response(stream));
    await expect(search({ query: "partial" })).rejects.toThrow(
      "SearXNG response incomplete after 7 bytes.",
    );
  });

  it("rejects private redirects from a public HTTPS endpoint", async () => {
    const fetch = mockFetch(Response.redirect("https://127.0.0.1/search"), []);

    await expect(search({ baseUrl: "https://search.example.com/searxng" })).rejects.toMatchObject({
      name: "SsrFBlockedError",
    });
    expectRequests(fetch, "https://search.example.com/searxng/search?q=openclaw&format=json");
  });

  it("allows private redirects from a configured internal HTTPS endpoint", async () => {
    const fetch = mockFetch(Response.redirect("https://127.0.0.1/search"), [
      { title: "Local result", url: "https://example.com/local" },
    ]);

    await expect(search({ baseUrl: "https://search.internal/searxng" })).resolves.toMatchObject({
      results: [{ url: "https://example.com/local" }],
    });
    expectRequests(
      fetch,
      "https://search.internal/searxng/search?q=openclaw&format=json",
      "https://127.0.0.1/search",
    );
  });

  it("rejects cleartext public hosts", async () => {
    const fetch = mockFetch([]);
    await expect(search({ baseUrl: "http://search.example.com:8080" })).rejects.toThrow(
      "SearXNG HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
