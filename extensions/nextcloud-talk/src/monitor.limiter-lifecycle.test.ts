import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerNextcloudTalkWebhook } from "./monitor.js";

afterEach(() => vi.useRealTimers());

describe("Nextcloud Talk shared webhook lifetime", () => {
  it("keeps the route and limiter until its last account stops, then releases both", () => {
    vi.useFakeTimers();
    const registry = createTestRegistry();
    setActivePluginRegistry(registry);
    const baselineTimerCount = vi.getTimerCount();
    const target = { path: "/w", secret: "s", onWebhook: async () => "ignored" as const };
    const first = registerNextcloudTalkWebhook(target);
    const second = registerNextcloudTalkWebhook({ ...target, secret: "other" });
    expect(registry.httpRoutes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);
    first();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);
    second();
    second();
    expect(registry.httpRoutes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
  });
});
