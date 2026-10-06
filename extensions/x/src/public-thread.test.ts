import { describe, expect, it, vi } from "vitest";
import { createXApiClient, type XPage, type XPost } from "./api.js";
import { verifyPublicXThread } from "./public-thread.js";

const post: XPost = { id: "1", author_id: "2", conversation_id: "1", text: "Public request" };
function page(): XPage {
  return {
    data: [post],
    includes: { tweets: [], users: [{ id: "2", username: "author", protected: false }] },
    meta: {},
  };
}

describe("public X context", () => {
  it("denies an unavailable conversation root even when its reply is public", async () => {
    const api = { getPublicPosts: vi.fn(async () => page()) };
    expect(
      await verifyPublicXThread(api, [{ ...post, id: "3" }], new AbortController().signal, "1"),
    ).toBe(false);
    expect(api.getPublicPosts).not.toHaveBeenCalled();
  });

  it.each(["public", "protected", "unknown", "missing", "changed", "withheld", "error"])(
    "fails closed for %s context",
    async (kind) => {
      const data = page();
      if (kind === "protected") {
        data.includes.users[0]!.protected = true;
      }
      if (kind === "unknown") {
        delete data.includes.users[0]!.protected;
      }
      if (kind === "missing") {
        data.data = [];
      }
      if (kind === "changed") {
        data.data = [{ ...post, text: "Edited" }];
      }
      if (kind === "withheld") {
        data.data = [{ ...post, withheld: true }];
      }
      const api = {
        getPublicPosts: vi.fn(async () => {
          if (kind === "error") {
            throw new Error("unavailable");
          }
          return data;
        }),
      };
      expect(await verifyPublicXThread(api, [post], new AbortController().signal, "1")).toBe(
        kind === "public",
      );
    },
  );

  it("uses only application authority and explicitly requests protected metadata", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/2/tweets");
      expect(url.searchParams.get("user.fields")).toContain("protected");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer app-only-fixture");
      return Response.json(page());
    });
    const api = createXApiClient({
      clientId: "fixture",
      clientSecret: "fixture",
      refreshToken: "fixture",
      bearerToken: "app-only-fixture",
      fetch: fetcher,
      saveRefreshToken: async () => {},
    });
    expect(await verifyPublicXThread(api, [post], new AbortController().signal, "1")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to user authority without an app-only token", async () => {
    const fetcher = vi.fn();
    const api = createXApiClient({
      clientId: "fixture",
      clientSecret: "fixture",
      refreshToken: "fixture",
      fetch: fetcher,
      saveRefreshToken: async () => {},
    });
    expect(await verifyPublicXThread(api, [post], new AbortController().signal, "1")).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
